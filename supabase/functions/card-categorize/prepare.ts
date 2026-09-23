// The coding PREPARATION service: suggests a QuickBooks account and location
// for card and bank transactions that no learned rule could answer, and records
// each suggestion as it arrives.
//
// One service, two callers: the bookkeeper's "Prepare coding" request
// (index.ts, a signed-in finance user) and, from the next change, the
// scheduled worker. Both reach prepareCoding() with an explicit company and
// batch; neither can name another company's rows, because every read and the
// writer are scoped to that company.
//
// Stored, eligible rows are grouped by merchant AND card name server-side, so
// a caller cannot disguise a bank transfer as a card purchase in model input.
//
// What this WRITES: card_coding_preparation_runs and, through
// record_card_coding_suggestions, card_coding_suggestions. Never
// card_transactions -- accepting a suggestion is a person's act
// (accept_card_coding_suggestions), and approval and posting are further steps
// again. READ ONLY with respect to QuickBooks. Nothing here posts.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const MODEL = Deno.env.get('CARD_CODING_MODEL') || 'claude-sonnet-5';

// One merchant is one question. Beyond this the request is split into several
// model calls rather than truncated -- a silently dropped merchant comes back
// as an uncoded row with no explanation, which is worse than a slower import.
// 40, not 60. A batch of 60 with real reasoning strings ran past max_tokens and
// came back truncated mid-array -- and truncation used to discard the whole
// batch, which is what "Some merchants failed" was.
const BATCH_SIZE = 40;
// Recorded on every run and suggestion, so a quality comparison can tell which
// prompt produced which answer.
export const PROMPT_VERSION = 'card-categorize/2026-09-23';
// A slice slower than this is recorded as failed (and retried later) rather
// than holding the whole request until the gateway's 150s cut, which would
// lose every slice with it.
const MODEL_TIMEOUT_MS = 110_000;
// Rows per record_card_coding_suggestions call. The writer refuses more than
// 2,000; 500 keeps each call short enough to hold its per-row locks briefly.
const RECORD_CHUNK = 500;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

type Merchant = {
  direction?: string;
  merchant: string;        // normalised key
  card_name?: string | null; // the issuer's card / cost centre, where there is one
  sample: string;          // one raw descriptor, for context
  count: number;
  total: number;
  anchor: string;          // EARLIEST txn_date in the group: history may not be later than any line
};

type Suggestion = {
  direction?: string;
  accounting_treatment?: string;
  merchant: string;
  card_name?: string | null;
  account_name: string | null;
  account_id?: string | null;
  location_name: string | null;
  vendor_name: string | null;
  confidence: number;
  reasoning: string;
  // Additive: what the company's own history says about this merchant, in one
  // line a bookkeeper can check, plus a machine-readable status.
  evidence?: string;
  history_status?: HistoryStatus;
};

// ---------------------------------------------------------------------------
// Historical coding evidence
//
// The prompt already knows which ACCOUNTS the company posts to (P&L usage) and
// which MERCHANTS have a learned rule. Neither answers the question that
// actually decides a near-duplicate -- "Insurance Expense" against "Insurance -
// General Liability" -- which is: where did THIS company put THIS vendor
// before? Two sources answer it, both company-scoped and both already in SILO:
//
//   1. Confirmed SILO codings: card_transactions rows a person stood behind.
//      'manual' and 'rule' count once saved; an 'ai' row counts ONLY once its
//      batch is approved or posted, because an accepted-but-unreviewed
//      suggestion is the model agreeing with itself.
//   2. The QBO ledger archive (qbo_history_lines): what the accountant coded
//      the vendor to in QuickBooks, before SILO existed for that period.
//
// History is read for the 24 months up to the EARLIEST line being coded,
// never after it, and never across companies or QuickBooks realms: matching,
// scoping and windowing all happen in card_coding_history_evidence
// (20260923140000), which matches each merchant BEFORE it caps, so a busy
// ledger can no longer push a merchant's history out of the sample. Recent, exact, confirmed matches outweigh old or similar
// ones. Where the sources disagree the conflict is shown, not resolved, and
// confidence is capped so a person looks. Where history is missing or could
// not be read, that is stated, and account-name similarity is NOT presented
// as ledger evidence.
// ---------------------------------------------------------------------------
const HISTORY_MONTHS = 24;
// Confidence ceilings applied AFTER the model answers. They only ever lower.
const HISTORY_CAPS = {
  consistent_disagree: 0.5,  // history clearly says X, the model chose Y
  conflicting: 0.55,         // history says X and Y
  inactive_only: 0.6,        // history points only at accounts no longer in the chart
  capped: 0.55,              // a source hit its page cap: partial, and it must land in the Low-confidence filter (< 0.6)
  none: 0.75,                // nothing confirmed in the window
  unavailable: 0.75,         // could not read one or both sources
};

type HistoryStatus = 'consistent' | 'conflicting' | 'inactive_only' | 'none' | 'unavailable';
type HistoryCandidate = {
  account: string; account_id: string; weight: number; count: number; last: string;
  silo: number; ledger: number; similar: number; memo: number;
};
type HistoryEvidence = {
  status: HistoryStatus;
  leading: HistoryCandidate | null;
  candidates: HistoryCandidate[];
  inactive: { account: string; count: number; last: string }[];
  ineligible: { account: string; count: number; last: string }[];
  window: { from: string; to: string };
  summary: string;   // one line, for the prompt and the response
  notes: string[];
  capped: boolean;   // a source stopped at its page cap: treat as partial
};
// Rows come back from card_coding_history_evidence already MATCHED to one
// merchant, scoped to this company and QuickBooks connection, confirmed, and
// inside that merchant's own window -- see the migration for each rule.
type SiloHistoryRow = { qbo_account_id: string; qbo_account_name: string | null; txn_date: string };
type ChartEntry = { name: string; type: string };
// exact = the payee is this merchant; memo = the line's memo is (QuickBooks
// bank-feed lines often carry the descriptor there and no payee); similar = a
// whole-word containment either way, which is a hint and never precedent.
type LedgerMatch = 'exact' | 'memo' | 'similar';
type LedgerHistoryRow = { qbo_account_id: string; account_name: string; transaction_date: string; match: LedgerMatch };

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
function monthsBefore(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return isoDate(d);
}
function monthsBetween(fromIso: string, toIso: string): number {
  const ms = new Date(`${toIso}T00:00:00Z`).getTime() - new Date(`${fromIso}T00:00:00Z`).getTime();
  return ms / (30.44 * 86_400_000);
}
// Recent confirmed coding beats old confirmed coding: a vendor moved from one
// account to another a year ago should read as the new account, not a tie.
function recencyWeight(dateIso: string, anchorIso: string): number {
  const m = monthsBetween(dateIso, anchorIso);
  return m <= 6 ? 1 : m <= 12 ? 0.7 : 0.4;
}

function buildEvidence(
  anchor: string,
  siloRows: SiloHistoryRow[],
  ledgerRows: LedgerHistoryRow[],
  eligibleById: Map<string, ChartEntry>,   // accounts this suggestion mode may use
  activeById: Map<string, ChartEntry> | null, // every active account in the chart; null = could not be read
  capped: { silo: boolean; ledger: boolean },
  unavailable: string[],
): HistoryEvidence {
  const from = monthsBefore(anchor, HISTORY_MONTHS);
  // The database already windowed these; this is the same rule again, so a
  // row dated after the transaction can never become precedent even if a
  // caller hands one in.
  const inWindow = (d: string) => d >= from && d <= anchor;
  const byAccount = new Map<string, HistoryCandidate>();
  const inactive = new Map<string, { account: string; count: number; last: string }>();
  const ineligible = new Map<string, { account: string; count: number; last: string }>();
  const unresolved = new Map<string, { account: string; count: number; last: string }>();
  const tally = (map: Map<string, { account: string; count: number; last: string }>, id: string, name: string, date: string) => {
    const cur = map.get(id) || { account: name, count: 0, last: '' };
    cur.count++; if (date > cur.last) cur.last = date; map.set(id, cur);
  };
  const bump = (id: string, name: string | null, date: string, weight: number, source: 'silo' | 'ledger', match: LedgerMatch) => {
    const chart = eligibleById.get(id);
    if (!chart) {
      // Still active in QuickBooks but not offered for this transaction type
      // (an income account in card mode) is a different fact from "removed
      // from the chart", and a reviewer must not be told the latter.
      // If the chart itself could not be read, "removed" is not a fact we
      // hold: say the state is unknown rather than recreating the false claim.
      if (!activeById) { tally(unresolved, id, name || id, date); return; }
      const live = activeById.get(id);
      if (live) tally(ineligible, id, live.name, date); else tally(inactive, id, name || id, date);
      return;
    }
    const cur = byAccount.get(id) || { account: chart.name, account_id: id, weight: 0, count: 0, last: '', silo: 0, ledger: 0, similar: 0, memo: 0 };
    cur.weight += weight; cur.count++; if (date > cur.last) cur.last = date;
    if (source === 'silo') cur.silo++; else cur.ledger++;
    if (match === 'similar') cur.similar++;
    if (match === 'memo') cur.memo++;
    byAccount.set(id, cur);
  };
  for (const r of siloRows) {
    if (!r.txn_date || !inWindow(r.txn_date)) continue;
    bump(String(r.qbo_account_id), r.qbo_account_name, r.txn_date, recencyWeight(r.txn_date, anchor), 'silo', 'exact');
  }
  // This company's own confirmed codings come first. The QuickBooks archive
  // records the PREVIOUS bookkeeping practice, and where the two disagree the
  // current one is right: backtested 2026-09-23 on 1,764 rows people coded
  // since 1 July (history strictly before each row), letting ledger volume
  // outvote SILO codings agreed with the person on 609 rows and let the
  // ledger speak only where SILO has none agreed on 858 (the old capped read:
  // 738), with confident-and-wrong down from 96 to 48. The ledger is still
  // read, and a merchant SILO has never seen is answered from it.
  const siloDecides = byAccount.size > 0;
  let ledgerSetAside = 0;
  for (const r of ledgerRows) {
    if (!r.transaction_date || !inWindow(r.transaction_date)) continue;
    if (siloDecides) { ledgerSetAside++; continue; }
    bump(String(r.qbo_account_id), r.account_name, r.transaction_date,
      recencyWeight(r.transaction_date, anchor) * (r.match === 'similar' ? 0.4 : 0.8), 'ledger', r.match);
  }
  const candidates = [...byAccount.values()].sort((a, b) => b.weight - a.weight || b.last.localeCompare(a.last));
  const total = candidates.reduce((n, c) => n + c.weight, 0);
  const notes: string[] = [];
  if (capped.silo) notes.push('SILO sample capped');
  if (capped.ledger) notes.push('ledger sample capped');
  if (!activeById) notes.push('account states unavailable');
  for (const u of unavailable) notes.push(`${u} unavailable`);
  const describe = (c: HistoryCandidate) => {
    const parts: string[] = [];
    if (c.silo) parts.push(`${c.silo} confirmed SILO coding${c.silo === 1 ? '' : 's'}`);
    if (c.ledger) {
      const how = [c.memo ? `${c.memo} by memo` : '', c.similar ? `${c.similar} by similar payee name` : ''].filter(Boolean).join(', ');
      parts.push(`${c.ledger} ledger line${c.ledger === 1 ? '' : 's'}${how ? ` (${how})` : ''}`);
    }
    return `${c.account} [${parts.join(', ')}; last ${c.last}]`;
  };
  const windowText = `${HISTORY_MONTHS} months before ${anchor}`;
  const suffix = notes.length ? ` (${notes.join('; ')})` : '';

  let status: HistoryStatus; let summary: string; let leading: HistoryCandidate | null = null;
  if (!candidates.length && !inactive.size && unavailable.length === 2) {
    status = 'unavailable';
    summary = `History unavailable: ${unavailable.join(' and ')} could not be read${suffix}.`;
  } else if (!candidates.length && inactive.size) {
    status = 'inactive_only';
    const list = [...inactive.values()].map((i) => `${i.account} [${i.count} line${i.count === 1 ? '' : 's'}; last ${i.last}]`).join('; ');
    summary = `History points only at accounts no longer in the active chart: ${list}${suffix}.`;
  } else if (!candidates.length) {
    status = 'none';
    summary = `No confirmed coding for this merchant in the ${windowText}${suffix}.`;
  } else {
    leading = candidates[0];
    const share = total > 0 ? leading.weight / total : 0;
    // A precedent needs weight AND at least one EXACT match (payee, memo or a
    // confirmed SILO coding). Similar names alone ("amazon" beside "amazon web
    // services") are a hint, never history, however many of them there are.
    const strong = leading.weight >= 0.8 && (leading.count - leading.similar) >= 1;
    if (!strong && candidates.every((c) => c.count === c.similar)) {
      status = 'conflicting';
      summary = `WEAK (similar payee names only, no exact match): ${candidates.slice(0, 3).map(describe).join('; ')}${suffix}.`;
    } else if (candidates.length === 1 && strong) {
      status = 'consistent';
      summary = `CONSISTENT: ${describe(leading)}${suffix}.`;
    } else if (share >= 0.75 && strong) {
      status = 'consistent';
      summary = `CONSISTENT (mostly): ${describe(leading)}; earlier or minor: ${candidates.slice(1, 3).map(describe).join('; ')}${suffix}.`;
    } else {
      status = 'conflicting';
      summary = `CONFLICTING: ${candidates.slice(0, 3).map(describe).join(' vs ')}${suffix}.`;
    }
    if (inactive.size) summary += ` Also coded to since-removed account(s): ${[...inactive.values()].map((i) => i.account).join(', ')}.`;
  }
  if (ineligible.size) summary += ` Also coded to account(s) not offered for this transaction type: ${[...ineligible.values()].map((i) => `${i.account} [${i.count}; last ${i.last}]`).join(', ')}.`;
  if (ledgerSetAside) summary += ` ${ledgerSetAside} QBO ledger line${ledgerSetAside === 1 ? '' : 's'} not weighed: this company's confirmed SILO codings take precedence.`;
  if (unresolved.size) summary += ` Also coded to account(s) whose current chart state could not be read: ${[...unresolved.values()].map((i) => `${i.account} [${i.count}; last ${i.last}]`).join(', ')}.`;
  return { status, leading, candidates, inactive: [...inactive.values()], ineligible: [...ineligible.values()],
    window: { from, to: anchor }, summary, notes, capped: capped.silo || capped.ledger };
}

// One merchant group's history, as the database matched it.
type RawHistory = { silo: SiloHistoryRow[]; ledger: LedgerHistoryRow[]; capped: { silo: boolean; ledger: boolean } };
// Merchants per call and matched lines kept per merchant and source. The cap
// is applied AFTER matching and exact matches come first, so a busy merchant
// can only crowd out its own oldest or weakest lines, never another's.
const HISTORY_PAIRS_PER_CALL = 50;
const HISTORY_PER_KEY = 100;
const HISTORY_SOURCES = ['SILO coding history', 'QBO ledger archive'];

// A merchant group asks about the 24 months up to its EARLIEST line: nothing
// dated after any line being coded may count as precedent for it. In a bank
// feed the direction is part of the question -- a Shopify payout and a
// Shopify subscription share a name and not an account.
const historyKey = (m: Merchant) => `${m.merchant}|${m.anchor}|${m.direction || ''}`;

// Reads matched history for every merchant group in the request. A failed
// read is recorded, never thrown: the request still returns suggestions, and
// each evidence line says history could not be consulted.
async function fetchHistory(
  supabase: any,
  companyId: string,
  connectionId: string,
  merchants: Merchant[],
): Promise<{ byKey: Map<string, RawHistory>; unavailable: string[]; stats: Record<string, unknown> }> {
  const pairs = new Map<string, { key: string; before: string; direction: string | null }>();
  for (const m of merchants) {
    if (m.merchant && m.anchor) pairs.set(historyKey(m), { key: m.merchant, before: m.anchor, direction: m.direction || null });
  }
  const byKey = new Map<string, RawHistory>();
  const entries = [...pairs.entries()];
  const results = await Promise.all(chunks(entries, HISTORY_PAIRS_PER_CALL).map(async (part) => {
    const { data, error } = await supabase.rpc('card_coding_history_evidence', {
      p_company: companyId, p_connection: connectionId, p_per_key: HISTORY_PER_KEY,
      p_pairs: part.map(([, p]) => p),
    });
    return { part, data, error };
  }));
  let failed = false, siloRows = 0, ledgerLines = 0, cappedKeys = 0;
  for (const { part, data, error } of results) {
    if (error || !data || !Array.isArray(data.rows) || !Array.isArray(data.totals)) { failed = true; continue; }
    const local = part.map(() => ({ silo: [] as SiloHistoryRow[], ledger: [] as LedgerHistoryRow[], capped: { silo: false, ledger: false } }));
    for (const r of data.rows) {
      const slot = local[Number(r.i)];
      if (!slot) continue;
      if (r.src === 'silo') slot.silo.push({ qbo_account_id: String(r.account_id), qbo_account_name: r.account_name ?? null, txn_date: String(r.date) });
      else slot.ledger.push({ qbo_account_id: String(r.account_id), account_name: String(r.account_name ?? r.account_id),
        transaction_date: String(r.date), match: r.match === 'memo' ? 'memo' : r.match === 'similar' ? 'similar' : 'exact' });
    }
    for (const t of data.totals) {
      const slot = local[Number(t.i)];
      if (!slot) continue;
      const got = t.src === 'silo' ? slot.silo.length : slot.ledger.length;
      if (Number(t.total) > got) slot.capped[t.src === 'silo' ? 'silo' : 'ledger'] = true;
    }
    part.forEach(([key], i) => {
      const slot = local[i];
      siloRows += slot.silo.length; ledgerLines += slot.ledger.length;
      if (slot.capped.silo || slot.capped.ledger) cappedKeys++;
      byKey.set(key, slot);
    });
  }
  // A failed call leaves its merchants with NO entry, so their evidence reads
  // "unavailable" rather than a confident "no history".
  const unavailable = failed ? HISTORY_SOURCES : [];
  return {
    byKey, unavailable,
    stats: {
      window_months: HISTORY_MONTHS, merchants: pairs.size, per_key: HISTORY_PER_KEY,
      silo_rows: siloRows, ledger_lines: ledgerLines, capped_merchants: cappedKeys,
      unavailable: failed ? HISTORY_SOURCES : undefined,
    },
  };
}

function evidenceFor(
  raw: Map<string, RawHistory>, m: Merchant, unavailable: string[],
  eligibleById: Map<string, ChartEntry>, activeById: Map<string, ChartEntry> | null,
): HistoryEvidence {
  const found = raw.get(historyKey(m));
  if (!found) return buildEvidence(m.anchor, [], [], eligibleById, activeById, { silo: false, ledger: false }, unavailable.length ? unavailable : HISTORY_SOURCES);
  return buildEvidence(m.anchor, found.silo, found.ledger, eligibleById, activeById, found.capped, []);
}

function systemPrompt(
  accounts: { name: string; type: string; sub: string | null; used: number | null }[],
  locations: string[],
  examples: { merchant: string; account: string; location: string | null }[],
  sourceName: string,
  relatedEntities: string[],
  companyName: string,
  cardNames: string[],
  bankMode = false,
  history: string[] = [],
) {
  // Sorted by what the company actually posts to, and annotated with it. A
  // flat alphabetical list is why "Shipping" got picked over "COGS - Shipping"
  // when the two are identical in type AND sub-type and only one of them
  // carries $2.8m of activity -- nothing in the name could have told it apart.
  const money = (n: number) => n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(1)}m`
    : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`;

  const acctList = [...accounts]
    .sort((a, b) => (b.used ?? -1) - (a.used ?? -1) || a.name.localeCompare(b.name))
    .map((a) => `- ${a.name} [${a.type}${a.sub ? ` / ${a.sub}` : ''}]`
      + (a.used === null ? ''
        : a.used > 0 ? ` -- ${money(a.used)} posted in the last full year`
        : ' -- NO activity in the last full year'))
    .join('\n');

  const anyUsage = accounts.some((a) => a.used !== null);

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
  return `${bankMode ? 'You suggest chart-of-accounts categories for bank transactions, with transaction type as supporting metadata.' : 'You review credit-card purchases.'} The company is ${companyName} and the account is "${sourceName}".

You are not told what trade this company is in. Infer it from the accounts, locations and merchants below rather than assuming one.

${bankMode ? 'Suggest an actual account_name from the chart below whenever the stored transaction evidence supports one. Also identify accounting_treatment: purchase, refund, deposit, transfer, card_payment, payroll_settlement, shopify_settlement, or unknown. Purchase/outflow and refund/inflow use expense or asset accounts. Deposit/inflow may use Income or Other Income only when evidence establishes revenue; a bank deposit alone is not revenue. Transfers and payroll/Shopify settlements use a specifically supported Other Current Asset or Other Current Liability clearing account, never an expense account. Card payments use the identified Credit Card or Accounts Payable account, never an expense account. Do not guess a clearing or card account from account type alone: require a named destination, explicit settlement evidence, or a confirmed coding example. If the COA destination is ambiguous, return account_name:null and explain what is missing, even if the transaction type is clear. Unknown treatment must return account_name:null. Echo direction exactly; never combine an inflow with an outflow.' : 'Suggest an account for each purchase, or decline when uncertain.'}

# Related entities -- the ONLY names that mean "not this company's expense"
${relatedEntities.length ? relatedEntities.map((e) => `- ${e}`).join('\n') : '(none on file)'}

These are separate businesses this company carries an intercompany balance with. If a CARD NAME clearly refers to one of them, the charge is NOT this company's expense -- it is money that entity owes, and it requires a reviewed intercompany account. For those lines return account_name: null and name the entity in reasoning. A utility bill on a related entity's card is not this company's utilities; coding it that way is plausible, silent, and wrong.

# The card names actually in this file
${cardNames.length ? cardNames.map((c) => `- ${c}`).join('\n') : '(this file has no card names)'}

Every card name NOT in the related-entity list above is this company's own -- a spend category, one of its own stores or locations, or an employee whose card it is. An employee name is NOT a related entity: code those lines normally from the merchant, and use the card name as the hint it is. Only names matching the related-entity list mean decline.

The card name is the internal card the charge was made on, and companies commonly use it as a cost centre. Where one is present it is strong evidence, and for some merchants it is BETTER evidence than the merchant: a payment processor like Bill.com, Melio or PayPal tells you nothing on its own, but the same charge on a card named for rent is rent. The same merchant may appear twice with different card names and should then get different accounts.

# The ONLY accounts you may use
Listed most-used first.${anyUsage ? ` Charts accumulate near-duplicates -- two accounts with the same name in different words, or the same words in a different order, sometimes identical in type AND sub-type. Where several accounts could fit, PREFER the one this company actually posts to. An account showing no activity beside a near-twin carrying real money is almost always the dead one, and coding to it fragments their reporting across accounts that should be a single line.

Treat this as strong evidence, not a rule: a genuinely new account is legitimately empty, so if a merchant clearly belongs somewhere unused, say so in reasoning and lower your confidence.` : ''}
${acctList}

# The ONLY locations you may use
${locations.map((l) => `- ${l}`).join('\n')}

# How this company has coded merchants before
${exampleList}

# Historical coding evidence for the lines you are given
Read from this company's own confirmed codings and its QuickBooks ledger archive, for the ${HISTORY_MONTHS} months up to each merchant's EARLIEST line in this request, never after it. This is the strongest evidence you have for choosing between similar accounts, because it says where THIS vendor was actually put, not where a vendor like it usually goes.
${history.length ? history.join('\n') : '(no history was consulted for these lines)'}

- CONSISTENT: prefer that account. Choose a different one only when the descriptor plainly shows a different kind of purchase, and say why.
- CONFLICTING: name the accounts history disagrees between in reasoning, pick the one the descriptor supports, and keep confidence below 0.6.
- No confirmed history, or history unavailable: say so in reasoning and do not claim precedent. An account NAME resembling the merchant is not history.
- Never cite history that is not listed above.

# Rules
- Echo back BOTH the merchant and the card_name you were given, unchanged, so the answer can be matched to the right line. Use null for card_name when the line had none.
- account_name MUST be copied EXACTLY from the account list above. Never invent one, never abbreviate, never fix a typo in it.
- location_name MUST be copied exactly from the location list, or be null. Null means "use the card's default location" -- prefer null over a guess. Only name a location when the merchant or card name clearly belongs to one store.
- vendor_name is the real company behind the descriptor in plain form ("AMZN Mktp US" -> "Amazon"). Null if you cannot tell.
- confidence is 0.0-1.0 and must reflect real uncertainty. Use below 0.6 whenever the merchant is ambiguous, generic, or could reasonably be two different accounts. A wrong code at high confidence is worse than an honest low one, because low confidence is what gets a human to look.
- reasoning is one short sentence a bookkeeper would accept. Say what the merchant is, not what you did. Where the card name is what decided it, say so.
${bankMode ? '- Card payments and transfers may have a supported balance-sheet category as described above; never categorize them as expenses.' : '- If a line looks like a card payment, transfer, or the card issuer itself rather than a purchase, set account_name to null and say so in reasoning -- those do not belong in an expense entry.'}
- A payment processor is not a merchant. "MELIO*AIR TIGER EXPRESS", "BILL.COM* WASHINGTON P", "SQ *BLUE BOTTLE" -- read past the processor to the actual payee, and code THAT. Where the descriptor names no payee at all, the card name is your only evidence; if that does not settle it either, return null rather than guessing.

Respond with JSON only, no prose, no code fence:
{"suggestions":[{"merchant":"...","card_name":null,${bankMode?'"direction":"outflow","accounting_treatment":"unknown",':''}"account_name":null,"location_name":null,"vendor_name":"...","confidence":0.0,"reasoning":"..."}]}
Every line you were given must appear exactly once.`;
}

async function askModel(
  merchants: Merchant[],
  accounts: { name: string; type: string; sub: string | null; used: number | null }[],
  locations: string[],
  examples: { merchant: string; account: string; location: string | null }[],
  sourceName: string,
  relatedEntities: string[],
  companyName: string,
  cardNames: string[],
  bankMode = false,
  history: string[] = [],
): Promise<{ suggestions: Suggestion[]; usage: Record<string, number> }> {
  const userMsg = merchants
    .map((m) =>
      `- merchant: "${m.merchant}" | card: ${m.card_name ? `"${m.card_name}"` : 'none'}`
      + (bankMode ? ` | direction: ${m.direction}` : '')
      + ` | example descriptor: "${m.sample}" | ${m.count} charge(s) | $${m.total.toFixed(2)} total`
    )
    .join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 24000,
      system: systemPrompt(
        accounts, locations, examples, sourceName, relatedEntities, companyName, cardNames, bankMode, history),
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

  const { suggestions, salvaged } = parseSuggestions(text);

  // The API says outright when it ran out of room. Worth surfacing, because a
  // truncated batch is a budget problem with a fix, not a model that had no
  // answers -- and from the coding screen those look identical.
  if (data.stop_reason === 'max_tokens' || salvaged) {
    console.warn(`card-categorize: response cut short (stop_reason=${data.stop_reason}); `
      + `kept ${suggestions.length} of ${merchants.length} asked`);
  }

  // The API's own token counts, summed per run. Measurements, never estimates.
  const usage: Record<string, number> = {};
  for (const [k, v] of Object.entries(data.usage || {})) if (typeof v === 'number') usage[k] = v;
  return { suggestions, usage };
}

// The model is asked for bare JSON and usually obliges, but a batch that runs
// out of tokens stops mid-array -- and first-brace-to-LAST-brace then produces
// a string that will not parse at all, discarding forty good suggestions over
// one half-written line. That is what "Some merchants failed: Expected ',' or
// ']' after array element" was.
// QBO reports nest arbitrarily deep -- sections inside sections, each with a
// Summary row. Every line that names an account carries ColData[0].id, so the
// walk keys on that rather than trying to model the report's shape.
// Which accounts this company actually posts to, from the most recent P&L
// SILO already holds. The report payload is the heaviest read in preparation,
// and it only changes when a new report run is stored -- so the computed map
// is cached per company, QuickBooks connection AND report run id. A new run is
// a new key; nothing is ever served across companies or realms, and an
// isolate that is recycled simply reads it again. Absent any run, every
// account is annotated null and the prompt says nothing about usage rather
// than implying everything is dead.
type UsageInfo = { map: Map<string, number> | null; from: string | null; to: string | null; cached?: boolean };
const usageCache = new Map<string, UsageInfo>();
const USAGE_CACHE_LIMIT = 32;
async function accountUsageFor(supabase: any, companyId: string, connectionId: string): Promise<UsageInfo> {
  const { data: head, error } = await supabase
    .from('quickbooks_report_runs')
    .select('id, start_date, end_date')
    .eq('company_entity_id', companyId)
    .eq('connection_id', connectionId)
    .in('report_name', ['ProfitAndLoss', 'ProfitAndLossDetail'])
    .eq('status', 'ok')
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !head?.id) return { map: null, from: null, to: null };
  const key = `${companyId}|${connectionId}|${head.id}`;
  const hit = usageCache.get(key);
  if (hit) return { ...hit, cached: true };
  const { data: full } = await supabase.from('quickbooks_report_runs').select('raw_response')
    .eq('id', head.id).eq('company_entity_id', companyId).maybeSingle();
  const info: UsageInfo = { map: full?.raw_response ? accountUsage(full.raw_response) : null, from: head.start_date ?? null, to: head.end_date ?? null };
  if (usageCache.size >= USAGE_CACHE_LIMIT) usageCache.delete(usageCache.keys().next().value as string);
  usageCache.set(key, info);
  return info;
}

function accountUsage(report: unknown): Map<string, number> {
  const out = new Map<string, number>();

  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }

    const cd = node.ColData;
    if (Array.isArray(cd) && cd[0]?.id) {
      const raw = String(cd[cd.length - 1]?.value ?? '').replace(/[^0-9.\-]/g, '');
      const amt = Number(raw);
      // Absolute value: a contra or credit-balance account is still IN USE, and
      // the question here is "does this company post here", not "which way".
      if (raw !== '' && isFinite(amt)) {
        const id = String(cd[0].id);
        out.set(id, (out.get(id) ?? 0) + Math.abs(amt));
      }
    }

    for (const k of Object.keys(node)) if (k !== 'ColData') walk(node[k]);
  };

  walk(report);
  return out;
}

function objectsIn(text: string, from: number): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; }
      if (depth < 0) return out;
    }
  }
  return out;
}

function parseSuggestions(text: string): { suggestions: Suggestion[]; salvaged: boolean } {
  // The first BALANCED object, so a trailing note or a brace inside a reasoning
  // sentence cannot end it early.
  const whole = objectsIn(text, 0)[0];
  if (whole) {
    try {
      const p = JSON.parse(whole);
      if (Array.isArray(p.suggestions)) return { suggestions: p.suggestions, salvaged: false };
    } catch { /* truncated -- salvage below */ }
  }

  const arr = text.indexOf('[');
  if (arr < 0) throw new Error('model_returned_no_json');

  const suggestions: Suggestion[] = [];
  for (const part of objectsIn(text, arr)) {
    try { suggestions.push(JSON.parse(part)); } catch { /* the cut-off last one */ }
  }
  if (!suggestions.length) throw new Error('model_returned_no_parsable_suggestions');
  return { suggestions, salvaged: true };
}

// ---------------------------------------------------------------------------
// Preparation: shared by the user endpoint and the scheduled worker
// ---------------------------------------------------------------------------
export type PrepareTrigger = 'manual' | 'retry' | 'background' | 'nightly';
export type PrepareRequest = {
  companyId: string;
  batchId: string;
  transactionIds: string[];
  trigger: PrepareTrigger;
  requestedBy: string | null;   // the signed-in person, or null for the scheduler
  retry: boolean;               // ask again even where a live suggestion stands
  authMs?: number;              // time the caller spent establishing who is asking
  // The scheduler selected rows that WERE eligible; one coded or excluded by a
  // person since is skipped, not a reason to refuse the rest. The bookkeeper's
  // endpoint keeps the strict refusal, because it names rows the page showed.
  skipIneligible?: boolean;
};
// Long enough to outlive a request the gateway cuts at 150s, short enough that
// a crashed claimant's rows come back within minutes.
const CLAIM_LEASE_SECONDS = 240;
export type PrepareResult = { status: number; body: Record<string, unknown> };

const VALID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const elapsed = (t: number) => Math.round(performance.now() - t);
const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export async function prepareCoding(supabase: any, request: PrepareRequest): Promise<PrepareResult> {
  const started = performance.now();
  const timings: Record<string, unknown> = request.authMs === undefined ? {} : { auth_ms: request.authMs };
  const fail = (status: number, error: string): PrepareResult => ({ status, body: { error } });
  const { companyId, transactionIds, retry } = request;
  // Refused before anything is claimed: without a key every call would fail,
  // be recorded as a failure and burn the rows' automatic retries for nothing.
  if (!ANTHROPIC_API_KEY) return fail(503, 'ANTHROPIC_API_KEY is not configured for this project.');
  let phase = performance.now();

  const { data: batch, error: batchError } = await supabase.from('card_import_batches')
    .select('id,source_id,status,origin,qbo_connection_id').eq('id', request.batchId)
    .eq('company_entity_id', companyId).maybeSingle();
  if (batchError) return fail(503, 'Could not load the card batch.');
  if (!batch) return fail(404, 'Card batch not found.');
  if (!['draft', 'categorized'].includes(batch.status)) {
    return fail(409, 'Reopen the batch before requesting coding suggestions.');
  }
  const { data: source, error: sourceError } = await supabase.from('card_sources')
    .select('id,display_name,source_type,ingest_mode,is_active,qbo_connection_id')
    .eq('id', batch.source_id).eq('company_entity_id', companyId).maybeSingle();
  if (sourceError) return fail(503, 'Could not load the card source.');
  if (!source || !source.is_active || !['bank','card'].includes(source.source_type)) {
    return fail(409, 'Choose an active bank or card account before requesting suggestions.');
  }
  const bankMode = source.source_type === 'bank';
  const connectionId = source.qbo_connection_id;
  if (!connectionId || (batch.qbo_connection_id && batch.qbo_connection_id !== connectionId)) {
    return fail(409, 'Bind the card source to the correct QuickBooks connection before requesting suggestions.');
  }
  const { data: connection, error: connectionError } = await supabase.from('quickbooks_connections')
    .select('id').eq('id', connectionId).eq('company_entity_id', companyId)
    .eq('is_active', true).maybeSingle();
  if (connectionError) return fail(503, 'Could not verify the QuickBooks connection.');
  if (!connection) return fail(409, 'The card source QuickBooks connection is not active.');

  // Fingerprints FIRST, facts second. If a row changes between the two reads
  // the fingerprint it carries no longer matches, and the writer refuses the
  // answer rather than recording it against facts the model never saw.
  const inputHash = new Map<string, string>();
  for (const part of chunks(transactionIds, 500)) {
    const { data, error } = await supabase.rpc('card_coding_input_hashes', { p_company: companyId, p_ids: part });
    if (error || !Array.isArray(data)) return fail(503, 'Could not read transaction revisions. Apply the card coding suggestions migration, then retry.');
    for (const r of data) inputHash.set(String(r.transaction_id), String(r.input_hash));
  }

  const selectedRows: any[] = [];
  // Keep each ID filter below URL/gateway limits and Supabase's row cap.
  for (const part of chunks(transactionIds, 100)) {
    const { data: rows, error } = await supabase.from('card_transactions_v')
      .select('id,merchant_norm,card_name,description,amount,currency,status,qbo_account_id,origin,provider_status,accounting_treatment,txn_date')
      .eq('company_entity_id', companyId).eq('batch_id', batch.id)
      .in('id', part);
    if (error || !rows) return fail(503, 'Could not load the selected card transactions.');
    selectedRows.push(...rows);
  }
  const ineligible = (row: any) => row.status !== 'uncoded' || row.qbo_account_id
      || !Number.isFinite(Number(row.amount)) || Number(row.amount) === 0 || (!bankMode && Number(row.amount) < 0) || row.currency !== 'USD'
      || row.origin !== batch.origin || (row.origin === 'plaid'
        && (row.provider_status !== 'posted' || (!bankMode && row.accounting_treatment !== 'purchase')));
  let skippedIneligible = 0;
  if (request.skipIneligible) {
    selectedRows.splice(0, selectedRows.length, ...selectedRows.filter((row) => !ineligible(row)));
    skippedIneligible = transactionIds.length - selectedRows.length;
  } else if (selectedRows.length !== transactionIds.length) {
    return fail(409, 'Some selected transactions are no longer in this batch. Reload it and try again.');
  }
  if (selectedRows.some(ineligible)) {
    return fail(409, bankMode
      ? 'Select uncoded, settled USD bank transactions. Reload this period to remove changed or unavailable rows.'
      : 'Card suggestions require uncoded purchase outflows. Save changes and review payments or pending rows separately.');
  }

  // Saved rules first. A row one of this company's rules already codes is the
  // rule's to answer: the page applies it the moment the import is opened, so
  // a model call about it is money spent on a question already settled. Same
  // decision as the page (card_coding_rule_match mirrors ruleMatches), and a
  // CONFLICT between a merchant rule and a card rule is not an answer -- those
  // rows still go on, since a person has to choose and evidence helps.
  const ruleAnswered = new Set<string>();
  for (const part of chunks(selectedRows.map((row) => String(row.id)), 1000)) {
    const { data, error } = await supabase.rpc('card_coding_rule_answered', { p_company: companyId, p_ids: part });
    if (error || !Array.isArray(data)) return fail(503, 'Could not check saved rules. Apply the coding evidence migration, then retry.');
    for (const r of data) ruleAnswered.add(String(r.transaction_id));
  }
  const answeredByRule = selectedRows.filter((row) => ruleAnswered.has(String(row.id))).length;
  if (answeredByRule) selectedRows.splice(0, selectedRows.length, ...selectedRows.filter((row) => !ruleAnswered.has(String(row.id))));

  // Work already done is not done again. A live suggestion about the current
  // facts stands -- including a dismissal -- unless someone explicitly asks
  // again. A failure is always retried: that is what the button is for.
  const readLive = async (ids: string[]) => {
    const live = new Map<string, any>();
    for (const part of chunks(ids, 100)) {
      const { data, error } = await supabase.from('card_coding_suggestions_v')
        .select('id,transaction_id,review_status,outcome,stale_reason')
        .eq('company_entity_id', companyId).in('transaction_id', part).in('review_status', ['open', 'dismissed']);
      if (error) return null;
      for (const r of data || []) live.set(String(r.transaction_id), r);
    }
    return live;
  };
  const stillNeeds = (row: any, live: Map<string, any>) => {
    const current = live.get(String(row.id));
    if (!current || current.stale_reason) return true;
    if (retry) return true;
    return current.review_status === 'open' && current.outcome === 'failed';
  };
  const before = await readLive(selectedRows.map((row) => String(row.id)));
  if (!before) return fail(503, 'Could not read prepared suggestions. Apply the card coding suggestions migration, then retry.');
  const unprepared = selectedRows.filter((row) => stillNeeds(row, before));
  let alreadyPrepared = selectedRows.length - unprepared.length;

  // Claim before paying. Rows another worker -- or another click -- is
  // preparing right now are left to it; the claim is released at the end and
  // expires by itself if this request dies first.
  const claimToken = crypto.randomUUID();
  const claimed = new Set<string>();
  for (const part of chunks(unprepared.map((row) => String(row.id)), 500)) {
    if (!part.length) continue;
    const { data, error } = await supabase.rpc('claim_card_coding_preparation',
      { p_company: companyId, p_ids: part, p_token: claimToken, p_lease_seconds: CLAIM_LEASE_SECONDS });
    if (error || !Array.isArray(data)) return fail(503, 'Could not reserve these transactions for preparation. Apply the background preparation migration, then retry.');
    for (const id of data) claimed.add(String(typeof id === 'string' ? id : Object.values(id)[0]));
  }
  const release = () => claimed.size
    ? supabase.rpc('release_card_coding_preparation', { p_token: claimToken }).then(() => undefined, () => undefined)
    : Promise.resolve();
  // The snapshot above was read BEFORE the claim. Another worker may have
  // prepared, saved and released these rows in between, so the claim alone
  // proves only that nobody is preparing them NOW. Ask again, holding it.
  const heldRows = unprepared.filter((row) => claimed.has(String(row.id)));
  const after = heldRows.length ? await readLive(heldRows.map((row) => String(row.id))) : new Map<string, any>();
  if (!after) { await release(); return fail(503, 'Could not re-read prepared suggestions. Retry.'); }
  // An explicit retry asks again about the suggestion the person was looking
  // at. If a DIFFERENT valid one landed in between (another tab's Ask again,
  // or a scheduled run), that answer is the retry they wanted: keep it.
  const stillWanted = (row: any) => {
    if (!stillNeeds(row, after)) return false;
    if (!retry) return true;
    const was = before.get(String(row.id)), now = after.get(String(row.id));
    if (!now || now.stale_reason || (now.review_status === 'open' && now.outcome === 'failed')) return true;
    return String(was?.id ?? '') === String(now.id ?? '');
  };
  const pendingRows = heldRows.filter(stillWanted);
  alreadyPrepared += heldRows.length - pendingRows.length;
  const inProgress = unprepared.length - heldRows.length;
  try {
    return await prepareClaimed();
  } finally {
    await release();
  }

  async function prepareClaimed(): Promise<PrepareResult> {

  const byStoredMerchant = new Map<string, Merchant>();
  const rowsByKey = new Map<string, any[]>();
  const groupKey = (merchant: unknown, card: unknown, direction?: string) =>
    `${String(merchant ?? '')}||${card == null ? '' : String(card)}${bankMode ? '||' + direction : ''}`;
  for (const row of pendingRows) {
    if (!row.merchant_norm) continue;
    const direction = Number(row.amount)<0?'inflow':'outflow';
    const key = groupKey(row.merchant_norm, row.card_name || null, direction);
    const merchant = byStoredMerchant.get(key) || {
      merchant: row.merchant_norm, card_name: row.card_name || null,
      sample: row.description || '', count: 0, total: 0, anchor: '',
      ...(bankMode ? {direction} : {}),
    };
    merchant.count++;
    merchant.total += bankMode ? Math.abs(Number(row.amount)) : Number(row.amount);
    // History may not be later than ANY line in the group, so the group asks
    // about the window ending at its earliest line. A row with no date counts
    // as today, which cannot move an earlier anchor.
    const rowDate = /^\d{4}-\d{2}-\d{2}$/.test(String(row.txn_date || '')) ? String(row.txn_date) : isoDate(new Date());
    if (!merchant.anchor || rowDate < merchant.anchor) merchant.anchor = rowDate;
    byStoredMerchant.set(key, merchant);
    rowsByKey.set(key, [...(rowsByKey.get(key) || []), row]);
  }
  const merchants = [...byStoredMerchant.values()];
  const sourceName: string = source.display_name || 'card';
  timings.load_ms = elapsed(phase);
  if (!merchants.length) return { status: 200, body: { ok: true, suggestions: [], run_id: null, already_prepared: alreadyPrepared,
    in_progress: inProgress, skipped_ineligible: skippedIneligible, answered_by_rule: answeredByRule, recorded: 0 } };

  phase = performance.now();
  // Every read below is independent of the others, so they run together --
  // history included, which is the slowest. The chart is read ONCE: the
  // accounts offered for this mode, the intercompany names and the "is it
  // still active" map are all cuts of it, and three reads of one table could
  // disagree with each other.
  const MODE_TYPES = [
    'Expense', 'Other Expense', 'Cost of Goods Sold',
    'Fixed Asset', 'Other Current Asset',
    ...(bankMode ? ['Other Asset','Income','Other Income','Other Current Liability','Credit Card','Accounts Payable'] : []),
  ];
  let ruleQuery = supabase
    .from('card_coding_rules')
    .select('pattern, qbo_account_name, qbo_location_name, hit_count')
    .eq('company_entity_id', companyId)
    .eq('is_active', true)
    .not('qbo_account_name', 'is', null)
    .order('hit_count', { ascending: false })
    .limit(120);
  ruleQuery = batch.origin === 'plaid' ? ruleQuery.eq('source_id', source.id)
    : ruleQuery.or(`source_id.is.null,source_id.eq.${source.id}`);
  // supabase is untyped here, so each read resolves to any; the history read
  // keeps its declared shape.
  const timed = async (name: string, work: PromiseLike<any>): Promise<any> => {
    const t = performance.now();
    try { return await work; } finally { readMs[name] = elapsed(t); }
  };
  const readMs: Record<string, number> = {};
  const [chartRes, usage, cardAcctsRes, locationRes, ruleRes, entityRes, rawHistory] = await Promise.all([
    timed('chart', supabase.from('quickbooks_accounts')
      .select('qbo_account_id, name, fully_qualified_name, account_type, account_sub_type')
      .eq('company_entity_id', companyId).eq('connection_id', connectionId).eq('is_active', true)),
    timed('usage', accountUsageFor(supabase, companyId, connectionId)),
    timed('card_sources', supabase.from('card_sources').select('credit_qbo_account_name')
      .eq('company_entity_id', companyId).eq('qbo_connection_id', connectionId)),
    timed('locations', supabase.from('quickbooks_locations').select('name, fully_qualified_name')
      .eq('company_entity_id', companyId).eq('connection_id', connectionId).eq('is_active', true)),
    timed('rules', ruleQuery),
    timed('company', supabase.from('entities').select('title').eq('id', companyId).maybeSingle()),
    timed('history', fetchHistory(supabase, companyId, connectionId, merchants)),
  ]);
  timings.context_reads_ms = readMs;
  timings.usage_cached = !!usage.cached;
  const chartRows: any[] = chartRes.error ? [] : (chartRes.data || []);

  type ChartAccount = { id: string; name: string; type: string; sub: string | null; used: number | null };
  const accounts: ChartAccount[] = chartRows.filter((a: any) => MODE_TYPES.includes(a.account_type)).map((a: any) => ({
    id: String(a.qbo_account_id),
    name: a.fully_qualified_name || a.name,
    type: a.account_type,
    sub: a.account_sub_type,
    used: usage.map ? (usage.map.get(String(a.qbo_account_id)) ?? 0) : null,
  }));
  if (!accounts.length) {
    return fail(400, 'No QuickBooks accounts pulled yet — run Pull accounts in Integrations.');
  }

  // The intercompany accounts ARE the list of related entities -- there is no
  // separate register of them, and asking the model to recognise "a name that
  // looks like a business rather than an employee" was exactly the guess that
  // made it decline 76 rows on a card belonging to a member of staff.
  const intercoRows = chartRows.filter((a: any) => ['Accounts Receivable', 'Accounts Payable'].includes(a.account_type));

  // The card feeds themselves settle to AP accounts ('Brex Account', 'Divvy
  // Account', 'Parker'), which are emphatically NOT related entities -- listing
  // them would invite the model to decline a card's own rows.
  const cardAccountNames = new Set((cardAcctsRes.data || [])
    .map((c: any) => String(c.credit_qbo_account_name || '').toLowerCase().trim())
    .filter(Boolean));

  // Only accounts that actually follow the intercompany naming convention --
  // "<entity> Receivable" or "Due From/To <entity>". Taking every AR/AP account
  // sweeps up 'Accrued', 'Accounts Payable (A/P)', 'American Express - LOC' and
  // 'Amazon Unavailable Balance'; that last one is the dangerous one, since a
  // list containing the word Amazon invites the model to decline Amazon rows.
  const INTERCO_NAME = /\sreceivable\s*$|^due\s+(from|to)\s+/i;

  const relatedEntities: string[] = [...new Set<string>(intercoRows
    .filter((a: any) => !cardAccountNames.has(String(a.name || '').toLowerCase().trim()))
    .filter((a: any) => INTERCO_NAME.test(String(a.name || '')))
    .map((a: any) => String(a.name || '')
      .replace(/\s*receivable\s*$/i, '')
      .replace(/^due\s+(from|to)\s+/i, '')
      .trim())
    .filter((n: string) => n && !/^accounts?$/i.test(n) && n.length > 2))]
    .sort();

  const locations: string[] = (locationRes.data || []).map((l: any) => String(l.fully_qualified_name || l.name));

  // A sample of what humans have already confirmed, most-used first.
  const examples = (ruleRes.data || [])
    .filter((r: any) => accounts.some((a) => a.name === r.qbo_account_name))
    .map((r: any) => ({
    merchant: r.pattern,
    account: r.qbo_account_name,
    location: locations.includes(r.qbo_location_name) ? r.qbo_location_name : null,
  }));

  // The company's own name, not a name baked into this function.
  const companyName = entityRes.data?.title || 'this company';

  // The card names in THIS file, rather than one company's examples. A card
  // named "VIRTUAL ACCT SHIPPING" means nothing to a company that names its
  // cards after branches or people.
  const cardNames = [...new Set(merchants
    .map((m) => String(m.card_name || '').trim())
    .filter(Boolean))].sort().slice(0, 40);

  const validAccounts = new Set(accounts.map((a) => a.name));
  const validLocations = new Set(locations);

  // What this company did with these merchants before. Every active account,
  // not only the types offered for this mode, so a live income account in
  // card mode is labelled "not offered here" rather than "removed".
  const eligibleById = new Map<string, ChartEntry>(accounts.map((a) => [a.id, { name: a.name, type: a.type }]));
  const activeById = new Map<string, ChartEntry>(chartRows
    .map((a: any) => [String(a.qbo_account_id), { name: a.fully_qualified_name || a.name, type: a.account_type }]));
  const history = {
    byKey: new Map(merchants.map((m) => [historyKey(m),
      evidenceFor(rawHistory.byKey, m, rawHistory.unavailable, eligibleById, activeById)] as [string, HistoryEvidence])),
    stats: rawHistory.stats,
  };
  timings.context_ms = elapsed(phase);
  timings.history_ms = readMs.history;

  // The run exists before any model call, so a request the gateway cuts off
  // still leaves a record of what it had finished.
  const { data: run, error: runError } = await supabase.from('card_coding_preparation_runs').insert({
    company_entity_id: companyId, source_id: source.id, batch_id: batch.id, qbo_connection_id: connectionId,
    trigger: request.trigger, requested_by: request.requestedBy, model: MODEL, prompt_version: PROMPT_VERSION,
    transactions_requested: pendingRows.length, groups_requested: merchants.length,
  }).select('id').single();
  if (runError || !run?.id) return fail(503, 'Could not record the preparation run. Apply the card coding suggestions migration, then retry.');
  const runId = String(run.id);

  const historyLine = (m: Merchant) => {
    const ev = history.byKey.get(historyKey(m));
    return ev ? `- "${m.merchant}" (history up to ${m.anchor}, its earliest line) -> ${ev.summary}` : null;
  };

  // Validates one model answer for one merchant group. The model's account
  // stands only if it is a single, active chart account of a type this
  // movement may carry; history then sets the confidence CEILING, never the
  // answer.
  const finalize = (m: Merchant, s: Suggestion | undefined, failure: Error | null): Suggestion & { failed?: string } => {
    const ev0 = history.byKey.get(historyKey(m));
    if (failure) {
      return {
        merchant: m.merchant, ...(bankMode ? {direction:m.direction,accounting_treatment:'unknown'} : {}),
        card_name: m.card_name ?? null, account_name: null, location_name: null, vendor_name: null, confidence: 0,
        reasoning: `Categorisation failed: ${failure.message.slice(0, 160)}`, evidence: ev0?.summary, history_status: ev0?.status,
        failed: failure.message.slice(0, 120),
      };
    }
    if (!s) {
      return {
        merchant: m.merchant, ...(bankMode ? {direction:m.direction,accounting_treatment:'unknown'} : {}),
        card_name: m.card_name ?? null, account_name: null, location_name: null, vendor_name: null, confidence: 0,
        reasoning: 'The model did not return a suggestion for this line.', evidence: ev0?.summary, history_status: ev0?.status,
        failed: 'model_omitted_line',
      };
    }

    const vocabulary = ['purchase','refund','deposit','transfer','card_payment','payroll_settlement','shopify_settlement','unknown'];
    let treatment = bankMode && vocabulary.includes(s.accounting_treatment || '') ? s.accounting_treatment! : bankMode ? 'unknown' : 'purchase';
    if (bankMode && ((treatment==='purchase' && m.direction!=='outflow') || (['refund','deposit'].includes(treatment) && m.direction!=='inflow'))) treatment='unknown';
    const allowedTypes: Record<string, string[]> = {
      purchase: ['Expense','Other Expense','Cost of Goods Sold','Fixed Asset','Other Asset','Other Current Asset'],
      refund: ['Expense','Other Expense','Cost of Goods Sold','Fixed Asset','Other Asset','Other Current Asset'],
      deposit: ['Income','Other Income'],
      transfer: ['Other Current Asset','Other Current Liability'],
      payroll_settlement: ['Other Current Asset','Other Current Liability'],
      shopify_settlement: ['Other Current Asset','Other Current Liability'],
      card_payment: ['Credit Card','Accounts Payable'],
    };
    const matchingAccounts = accounts.filter(a=>a.name===s.account_name);
    const candidate = matchingAccounts.length===1 ? matchingAccounts[0] : null;
    const canSuggestAccount = !!candidate && (allowedTypes[treatment] || []).includes(candidate.type);
    const acct = canSuggestAccount ? candidate!.name : null;
    const disallowedAccount = !!s.account_name && !canSuggestAccount;
    const invented = !!s.account_name && !validAccounts.has(s.account_name);
    const loc = acct && s.location_name && validLocations.has(s.location_name) ? s.location_name : null;

    // History decides the CEILING, never the answer: the model's account
    // stands (subject to the chart/type checks above), but a choice that
    // contradicts consistent history, sits on conflicting history, or has
    // no history at all cannot carry high confidence -- low confidence is
    // what gets a person to look.
    const ev = history.byKey.get(historyKey(m));
    let confidence = disallowedAccount ? 0 : Math.max(0, Math.min(1, Number(s.confidence) || 0));
    let evidence = ev?.summary || 'History was not consulted for this line.';
    if (ev && acct) {
      const agrees = ev.leading?.account === acct;
      if (ev.status === 'consistent' && !agrees) {
        confidence = Math.min(confidence, HISTORY_CAPS.consistent_disagree);
        evidence = `History points to ${ev.leading!.account}; the model chose ${acct}. ${ev.summary}`;
      } else if (ev.status === 'consistent') {
        evidence = `History agrees. ${ev.summary}`;
      } else if (ev.status === 'conflicting') {
        confidence = Math.min(confidence, HISTORY_CAPS.conflicting);
        evidence = `${agrees && !ev.summary.startsWith('WEAK') ? 'The model chose the leading account, but history is split. ' : ''}${ev.summary}`;
      } else if (ev.status === 'inactive_only') {
        confidence = Math.min(confidence, HISTORY_CAPS.inactive_only);
      } else if (ev.status === 'none') {
        confidence = Math.min(confidence, HISTORY_CAPS.none);
      } else if (ev.status === 'unavailable') {
        confidence = Math.min(confidence, HISTORY_CAPS.unavailable);
      }
      // A capped source is a partial sample whatever it appears to say.
      if (ev.capped) {
        confidence = Math.min(confidence, HISTORY_CAPS.capped);
        evidence = `History sample capped, treat as partial. ${evidence}`;
      }
    }

    return {
      merchant: m.merchant,
      ...(bankMode ? {direction:m.direction,accounting_treatment:treatment} : {}),
      card_name: m.card_name ?? null,
      account_name: acct,
      account_id: acct ? candidate!.id : null,
      location_name: loc,
      vendor_name: s.vendor_name || null,
      confidence,
      reasoning: invented
        ? `Suggested "${s.account_name}", which is not in the chart of accounts — needs coding by hand.`
        : `${disallowedAccount ? 'Model account suggestion discarded: the category is ambiguous or incompatible with this transaction type. ' : ''}${String(s.reasoning || '')}`.slice(0, 400),
      evidence: evidence.slice(0, 600),
      history_status: ev?.status,
    };
  };

  const out: Suggestion[] = [];
  const errors: string[] = [];
  const totals = { recorded: 0, suggested: 0, needs_judgment: 0, failed: 0, skipped: 0, model_calls: 0, model_calls_failed: 0 };
  const tokenUsage: Record<string, number> = {};
  const modelCallMs: number[] = [];
  let persistMs = 0;

  // Saves one slice's answers the moment they exist, so a slow or failed call
  // elsewhere cannot take finished work down with it. Progress lands on the
  // run row for the page to show.
  let progress: Promise<unknown> = Promise.resolve();
  const persistSlice = async (answers: (Suggestion & { failed?: string })[]) => {
    const rows: Record<string, unknown>[] = [];
    for (const s of answers) {
      for (const t of rowsByKey.get(groupKey(s.merchant, s.card_name ?? null, s.direction)) || []) {
        const outcome = s.failed ? 'failed' : s.account_id ? 'suggested' : 'needs_judgment';
        rows.push({
          transaction_id: t.id, expected_input_hash: inputHash.get(String(t.id)) || null, outcome,
          qbo_account_id: outcome === 'suggested' ? s.account_id : null,
          location_name: s.location_name, vendor_name: s.vendor_name,
          accounting_treatment: bankMode ? s.accounting_treatment : 'purchase',
          confidence: s.confidence, reasoning: s.reasoning, evidence: s.evidence, history_status: s.history_status,
          error_code: s.failed || null, model: MODEL, prompt_version: PROMPT_VERSION,
        });
      }
    }
    if (!rows.length) return;
    // One merchant group expands to every transaction sharing its merchant and
    // card, so a single slice can carry thousands of rows. The writer takes a
    // bounded payload; send it in chunks, and keep whatever landed if a later
    // chunk fails.
    for (const part of chunks(rows, RECORD_CHUNK)) {
      const t = performance.now();
      const { data, error } = await supabase.rpc('record_card_coding_suggestions', { p_run_id: runId, p_rows: part, p_retry: retry });
      persistMs += elapsed(t);
      if (error) { errors.push(`record: ${String(error.message || error).slice(0, 160)}`); continue; }
      const skipped = Array.isArray(data?.skipped) ? data.skipped : [];
      const skippedIds = new Set(skipped.map((x: any) => String(x.transaction_id)));
      totals.recorded += Number(data?.recorded || 0); totals.skipped += skipped.length;
      for (const r of part) {
        if (skippedIds.has(String(r.transaction_id))) continue;
        if (r.outcome === 'suggested') totals.suggested++; else if (r.outcome === 'failed') totals.failed++; else totals.needs_judgment++;
      }
    }
    progress = progress.then(() => supabase.from('card_coding_preparation_runs').update({
      model_calls: totals.model_calls, model_calls_failed: totals.model_calls_failed,
      suggestions_recorded: totals.suggested, needs_judgment_recorded: totals.needs_judgment,
      failures_recorded: totals.failed, skipped: totals.skipped,
    }).eq('id', runId)).catch(() => undefined);
  };

  const slices: Merchant[][] = chunks(merchants, BATCH_SIZE);

  // CONCURRENT, not sequential. Each call has taken ~65s, and Supabase's
  // gateway kills the request at 150s. Capped at 4 in flight to stay clear of
  // the API's own rate limits.
  const LIMIT = 4;
  let next = 0;
  phase = performance.now();
  await Promise.all(Array.from({ length: Math.min(LIMIT, slices.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= slices.length) return;
      const slice = slices[i];
      let answers: (Suggestion & { failed?: string })[];
      const callStarted = performance.now();
      try {
        const sliceHistory = [...new Set(slice.map(historyLine).filter((l): l is string => !!l))];
        const result = await askModel(
          slice, accounts, locations, examples, sourceName, relatedEntities,
          companyName, cardNames, bankMode, sliceHistory);
        for (const [k, v] of Object.entries(result.usage)) tokenUsage[k] = (tokenUsage[k] || 0) + v;
        // Answers are matched back on the merchant AND card pair, since the same
        // merchant can legitimately appear twice with different cards.
        const byMerchant = new Map((result.suggestions || []).map((s) => [groupKey(s.merchant, s.card_name, s.direction), s]));
        answers = slice.map((m) => finalize(m, byMerchant.get(groupKey(m.merchant, m.card_name, m.direction)), null));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        errors.push(error.message);
        totals.model_calls_failed++;
        answers = slice.map((m) => finalize(m, undefined, error));
      }
      totals.model_calls++;
      modelCallMs.push(elapsed(callStarted));
      out.push(...answers);
      await persistSlice(answers);
    }
  }));
  timings.model_ms = elapsed(phase);
  timings.model_call_ms = modelCallMs;
  timings.persist_ms = persistMs;
  timings.total_ms = elapsed(started);
  await progress;

  const status = totals.failed === 0 && !errors.length ? 'completed'
    : totals.suggested + totals.needs_judgment > 0 ? 'partial' : 'failed';
  await supabase.from('card_coding_preparation_runs').update({
    status, model_calls: totals.model_calls, model_calls_failed: totals.model_calls_failed,
    suggestions_recorded: totals.suggested, needs_judgment_recorded: totals.needs_judgment,
    failures_recorded: totals.failed, skipped: totals.skipped,
    timings, usage: tokenUsage, error: errors.length ? errors.slice(0, 3).join(' | ').slice(0, 500) : null,
    finished_at: new Date().toISOString(),
  }).eq('id', runId);

  return {
    status: 200,
    body: {
      ok: true,
      run_id: runId,
      run_status: status,
      suggestions: out.map(({ failed: _failed, ...s }: any) => s),
      recorded: totals.recorded,
      suggested: totals.suggested,
      needs_judgment: totals.needs_judgment,
      failed: totals.failed,
      skipped: totals.skipped,
      already_prepared: alreadyPrepared,
      in_progress: inProgress,
      skipped_ineligible: skippedIneligible,
      answered_by_rule: answeredByRule,
      merchants_asked: merchants.length,
      batches: slices.length,
      related_entities: relatedEntities.length,
      company: companyName,
      usage_from: usage.map ? `${usage.from} to ${usage.to}` : null,
      accounts_with_activity: usage.map ? accounts.filter((a) => (a.used ?? 0) > 0).length : null,
      history: history.stats,
      model: MODEL,
      timings,
      token_usage: tokenUsage,
      errors: errors.length ? errors : undefined,
    },
  };
  }
}

// ---------------------------------------------------------------------------
// The bookkeeper's endpoint: authenticate a person, derive their company
// ---------------------------------------------------------------------------
export function createCategorizeHandler({ createDb }: { createDb: () => any }) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    if (!ANTHROPIC_API_KEY) {
      return json({ error: 'ANTHROPIC_API_KEY is not configured for this project.' }, 503);
    }
    const started = performance.now();
    const supabase = createDb();

    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', ''),
    );
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const validId = (value: unknown) => typeof value === 'string' && VALID_ID.test(value);
    const transactionIds = body?.transaction_ids;
    if (!validId(body?.batch_id) || !Array.isArray(transactionIds) || !transactionIds.length
        || transactionIds.length > 5000 || transactionIds.some((id: unknown) => !validId(id))
        || new Set(transactionIds).size !== transactionIds.length
        || (body.retry !== undefined && typeof body.retry !== 'boolean')) {
      return json({ error: 'Select saved transactions from a card batch, then try again.' }, 400);
    }

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

    const allowed = String(profile.role) === 'executive' || (membership
      ? membership.role === 'owner_admin' || ['finance', 'exec'].includes(String(profile.department))
      : ['owner', 'executive'].includes(String(profile.role))
        || ['finance', 'exec'].includes(String(profile.department)));
    if (!allowed) return json({ error: 'Finance access required' }, 403);

    const result = await prepareCoding(supabase, {
      companyId, batchId: body.batch_id, transactionIds, requestedBy: user.id,
      trigger: body.retry ? 'retry' : 'manual', retry: body.retry === true, authMs: elapsed(started),
    });
    return json(result.body, result.status);
  };
}
