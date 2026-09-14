// Suggests a QuickBooks account and location for card transactions that no
// learned rule could answer.
//
// The caller applies rules first and sends the remaining transaction IDs.
// Stored, eligible rows are grouped by merchant AND card name server-side, so
// a caller cannot disguise a bank transfer as a card purchase in model input.
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
// 40, not 60. A batch of 60 with real reasoning strings ran past max_tokens and
// came back truncated mid-array -- and truncation used to discard the whole
// batch, which is what "Some merchants failed" was.
const BATCH_SIZE = 40;

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
  anchor: string;          // latest txn_date in the group: history must PRECEDE it
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
// History is read for the 24 months PRECEDING the transaction being coded,
// never after it, and never across companies: SILO rows carry the company id,
// ledger lines are reached only through imports for this company AND this
// QBO connection. Recent, exact, confirmed matches outweigh old or similar
// ones. Where the sources disagree the conflict is shown, not resolved, and
// confidence is capped so a person looks. Where history is missing or could
// not be read, that is stated, and account-name similarity is NOT presented
// as ledger evidence.
// ---------------------------------------------------------------------------
const HISTORY_MONTHS = 24;
// Both sources are paged deterministically (newest first, then row id) and
// stop at a cap that is DISCLOSED: a silent API row limit would hand back an
// arbitrary partial sample that could still read as consistent history.
const HISTORY_PAGE = 1000;
const HISTORY_MAX_PAGES = 5;
// Ledger lines on settlement-side accounts (the AP or card leg of a bill) say
// how it was PAID, not what it WAS; only the expense/asset/income leg counts.
const LEDGER_EVIDENCE_TYPES = [
  'Expense', 'Other Expense', 'Cost of Goods Sold', 'Fixed Asset', 'Other Asset',
  'Other Current Asset', 'Income', 'Other Income',
];
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
  silo: number; ledger: number; similar: number;
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
type SiloHistoryRow = {
  merchant_norm: string; txn_date: string; qbo_account_id: string; qbo_account_name: string | null;
  coding_source: string; batch_status: string; status: string; source_key: string | null; batch_id: string;
};
type ChartEntry = { name: string; type: string };
type LedgerHistoryRow = {
  qbo_account_id: string; account_name: string; transaction_date: string; counterparty: string | null;
  qbo_transaction_id: string | null; natural_amount: number | string;
};

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
// Mirrors public.normalize_merchant (and the copy in v2/transactions.html) so
// a ledger counterparty and a card descriptor reduce to the same key. Changing
// one without the others silently stops history matching.
function normalizeMerchant(text: unknown): string {
  let t = String(text || '').toLowerCase();
  t = t.replace(/^(sq|tst|sp|py|paypal|pp|ppl|dd|ec)\s*\*+\s*/i, '');
  t = t.replace(/\s*\*+\s*[a-z0-9-]*[0-9][a-z0-9-]*\s*$/g, '');
  t = t.replace(/\s*[#*]?\s*[0-9]{2,}\s*$/g, '');
  t = t.replace(/\s+[a-z0-9]*[0-9][a-z0-9]{3,}\s*$/g, '');
  t = t.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}
// "state farm" against "state farm insurance co": the same payee under a
// longer ledger name. Only whole-word containment of a key at least four
// characters long, so "sun" does not claim "sunrise bakery".
function similarKey(key: string, other: string): boolean {
  if (!key || !other || key === other) return false;
  const [short, long] = key.length <= other.length ? [key, other] : [other, key];
  if (short.length < 4) return false;
  return (` ${long} `).includes(` ${short} `);
}

function buildEvidence(
  key: string,
  anchor: string,
  siloRows: SiloHistoryRow[],
  ledgerRows: LedgerHistoryRow[],
  eligibleById: Map<string, ChartEntry>,   // accounts this suggestion mode may use
  activeById: Map<string, ChartEntry> | null, // every active account in the chart; null = could not be read
  capped: { silo: boolean; ledger: boolean },
  unavailable: string[],
): HistoryEvidence {
  const from = monthsBefore(anchor, HISTORY_MONTHS);
  const inWindow = (d: string) => d >= from && d <= anchor;
  const byAccount = new Map<string, HistoryCandidate>();
  const inactive = new Map<string, { account: string; count: number; last: string }>();
  const ineligible = new Map<string, { account: string; count: number; last: string }>();
  const unresolved = new Map<string, { account: string; count: number; last: string }>();
  const tally = (map: Map<string, { account: string; count: number; last: string }>, id: string, name: string, date: string) => {
    const cur = map.get(id) || { account: name, count: 0, last: '' };
    cur.count++; if (date > cur.last) cur.last = date; map.set(id, cur);
  };
  const bump = (id: string, name: string | null, date: string, weight: number, source: 'silo' | 'ledger', similar: boolean) => {
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
    const cur = byAccount.get(id) || { account: chart.name, account_id: id, weight: 0, count: 0, last: '', silo: 0, ledger: 0, similar: 0 };
    cur.weight += weight; cur.count++; if (date > cur.last) cur.last = date;
    if (source === 'silo') cur.silo++; else cur.ledger++;
    if (similar) cur.similar++;
    byAccount.set(id, cur);
  };
  for (const r of siloRows) {
    if (r.merchant_norm !== key || !r.txn_date || !inWindow(r.txn_date)) continue;
    bump(String(r.qbo_account_id), r.qbo_account_name, r.txn_date, recencyWeight(r.txn_date, anchor), 'silo', false);
  }
  for (const r of ledgerRows) {
    const cp = normalizeMerchant(r.counterparty);
    const exact = cp === key;
    if (!exact && !similarKey(key, cp)) continue;
    if (!r.transaction_date || !inWindow(r.transaction_date)) continue;
    bump(String(r.qbo_account_id), r.account_name, r.transaction_date,
      recencyWeight(r.transaction_date, anchor) * (exact ? 0.8 : 0.4), 'ledger', !exact);
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
    if (c.ledger) parts.push(`${c.ledger} ledger line${c.ledger === 1 ? '' : 's'}${c.similar ? ` (${c.similar} by similar payee name)` : ''}`);
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
    // A precedent needs weight AND at least one EXACT match. Similar payee
    // names alone ("amazon" beside "amazon web services") are a hint, never
    // history, however many of them there are.
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
  if (unresolved.size) summary += ` Also coded to account(s) whose current chart state could not be read: ${[...unresolved.values()].map((i) => `${i.account} [${i.count}; last ${i.last}]`).join(', ')}.`;
  return { status, leading, candidates, inactive: [...inactive.values()], ineligible: [...ineligible.values()],
    window: { from, to: anchor }, summary, notes, capped: capped.silo || capped.ledger };
}

// Reads both sources for every merchant in the request. A read failure on one
// source degrades to the other and is recorded, never thrown: the request
// should still return suggestions, and the evidence line should say that the
// ledger (or SILO history) could not be consulted.
async function loadHistory(
  supabase: any,
  companyId: string,
  connectionId: string,
  merchants: Merchant[],
  eligibleById: Map<string, ChartEntry>,
  activeById: Map<string, ChartEntry> | null,
): Promise<{ byKey: Map<string, HistoryEvidence>; stats: Record<string, unknown> }> {
  const keys = [...new Set(merchants.map((m) => m.merchant).filter(Boolean))];
  const anchors = merchants.map((m) => m.anchor);
  const windowTo = anchors.reduce((a, b) => (a > b ? a : b));
  const windowFrom = monthsBefore(anchors.reduce((a, b) => (a < b ? a : b)), HISTORY_MONTHS);
  const unavailable: string[] = [];
  const capped = { silo: false, ledger: false };

  // 1. Confirmed SILO codings, this company only, keyed on the same merchant
  //    key the request uses, and ONLY from card sources bound to this QBO
  //    connection. An account id is only meaningful inside its realm: a
  //    company that moved realms can have an old "42 = Travel" and a current
  //    "42 = Advertising", and a row from the old realm must not be relabelled
  //    as current precedent. The binding that matters is the BATCH's own
  //    qbo_connection_id, frozen when the batch was made, not the source's
  //    current one: a CSV source can be rebound from realm A to realm B while
  //    its realm-A batches keep their own binding. A batch with no binding at
  //    all (made before batches recorded one) falls back to its source's
  //    current connection, which is the best fact available for it. Both are
  //    checked BEFORE any account id is resolved. Confirmation is decided
  //    HERE, not in SQL, so the rule is one place and testable.
  const siloRows: SiloHistoryRow[] = [];
  const { data: sourceRows, error: sourceError } = await supabase
    .from('card_sources')
    .select('source_key,qbo_connection_id')
    .eq('company_entity_id', companyId)
    .eq('qbo_connection_id', connectionId);
  const sourceKeys = new Set<string>((sourceRows || []).map((r: any) => String(r.source_key)));
  const batchConnection = new Map<string, string | null>();
  let batchError: unknown = null;
  for (let page = 0; page < HISTORY_MAX_PAGES && !batchError; page++) {
    const { data, error } = await supabase
      .from('card_import_batches')
      .select('id,qbo_connection_id')
      .eq('company_entity_id', companyId)
      .order('id', { ascending: true })
      .range(page * HISTORY_PAGE, (page + 1) * HISTORY_PAGE - 1);
    if (error) { batchError = error; break; }
    for (const b of data || []) batchConnection.set(String(b.id), b.qbo_connection_id ? String(b.qbo_connection_id) : null);
    if ((data || []).length < HISTORY_PAGE) break;
  }
  const rowIsBoundHere = (r: SiloHistoryRow) => {
    if (!batchConnection.has(String(r.batch_id))) return false;
    const bound = batchConnection.get(String(r.batch_id));
    return bound ? bound === connectionId : sourceKeys.has(String(r.source_key));
  };
  if (sourceError || batchError) unavailable.push('SILO coding history');
  else {
    keyLoop: for (let i = 0; i < keys.length; i += 100) {
      for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
        const { data, error } = await supabase
          .from('card_transactions_v')
          .select('merchant_norm,txn_date,qbo_account_id,qbo_account_name,coding_source,batch_status,status,source_key,batch_id')
          .eq('company_entity_id', companyId)
          .eq('status', 'coded')
          .not('qbo_account_id', 'is', null)
          .in('merchant_norm', keys.slice(i, i + 100))
          .gte('txn_date', windowFrom)
          .lte('txn_date', windowTo)
          .order('txn_date', { ascending: false })
          .order('id', { ascending: true })
          .range(page * HISTORY_PAGE, (page + 1) * HISTORY_PAGE - 1);
        if (error) { unavailable.push('SILO coding history'); siloRows.length = 0; break keyLoop; }
        for (const r of data || []) {
          if (!rowIsBoundHere(r)) continue;
          const confirmed = r.coding_source === 'manual' || r.coding_source === 'rule'
            || (r.coding_source === 'ai' && ['approved', 'posted'].includes(String(r.batch_status)));
          if (confirmed && r.batch_status !== 'voided') siloRows.push(r);
        }
        if ((data || []).length < HISTORY_PAGE) break;
        if (page === HISTORY_MAX_PAGES - 1) capped.silo = true;
      }
    }
  }

  // 2. The QBO ledger archive, reached only through this company's imports for
  //    THIS connection. Lines are not keyed by merchant, so the window's
  //    expense-side lines are paged in and matched here; a cap is reported.
  const ledgerRows: LedgerHistoryRow[] = [];
  let ledgerImports = 0;
  const { data: imports, error: importsError } = await supabase
    .from('qbo_history_imports')
    .select('id')
    .eq('company_entity_id', companyId)
    .eq('qbo_connection_id', connectionId);
  if (importsError) unavailable.push('QBO ledger archive');
  else if ((imports || []).length) {
    ledgerImports = imports.length;
    const importIds = imports.map((i: any) => i.id);
    const seen = new Set<string>();
    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
      const { data, error } = await supabase
        .from('qbo_history_lines')
        .select('qbo_account_id,account_name,transaction_date,counterparty,qbo_transaction_id,natural_amount')
        .eq('company_entity_id', companyId)
        .in('import_id', importIds)
        .eq('row_kind', 'transaction')
        .in('account_type', LEDGER_EVIDENCE_TYPES)
        .gte('transaction_date', windowFrom)
        .lte('transaction_date', windowTo)
        .order('transaction_date', { ascending: false })
        .range(page * HISTORY_PAGE, (page + 1) * HISTORY_PAGE - 1);
      if (error) { unavailable.push('QBO ledger archive'); ledgerRows.length = 0; break; }
      for (const r of data || []) {
        // Overlapping snapshots hold the same QuickBooks line twice.
        const id = `${r.qbo_transaction_id || ''}|${r.qbo_account_id}|${r.transaction_date}|${r.natural_amount}|${r.counterparty || ''}`;
        if (seen.has(id)) continue;
        seen.add(id); ledgerRows.push(r);
      }
      if ((data || []).length < HISTORY_PAGE) break;
      if (page === HISTORY_MAX_PAGES - 1) capped.ledger = true;
    }
  }

  const byKey = new Map<string, HistoryEvidence>();
  for (const m of merchants) {
    if (!m.merchant || byKey.has(`${m.merchant}|${m.anchor}`)) continue;
    byKey.set(`${m.merchant}|${m.anchor}`, buildEvidence(m.merchant, m.anchor, siloRows, ledgerRows, eligibleById, activeById, capped, unavailable));
  }
  return {
    byKey,
    stats: {
      window_months: HISTORY_MONTHS, silo_rows: siloRows.length, silo_capped: capped.silo,
      ledger_lines: ledgerRows.length, ledger_imports: ledgerImports, ledger_capped: capped.ledger,
      unavailable: unavailable.length ? unavailable : undefined,
    },
  };
}
const historyKey = (m: Merchant) => `${m.merchant}|${m.anchor}`;

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
Read from this company's own confirmed codings and its QuickBooks ledger archive, for the ${HISTORY_MONTHS} months BEFORE each line's date. This is the strongest evidence you have for choosing between similar accounts, because it says where THIS vendor was actually put, not where a vendor like it usually goes.
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
): Promise<Suggestion[]> {
  const userMsg = merchants
    .map((m) =>
      `- merchant: "${m.merchant}" | card: ${m.card_name ? `"${m.card_name}"` : 'none'}`
      + (bankMode ? ` | direction: ${m.direction}` : '')
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

  return suggestions;
}

// The model is asked for bare JSON and usually obliges, but a batch that runs
// out of tokens stops mid-array -- and first-brace-to-LAST-brace then produces
// a string that will not parse at all, discarding forty good suggestions over
// one half-written line. That is what "Some merchants failed: Expected ',' or
// ']' after array element" was.
// QBO reports nest arbitrarily deep -- sections inside sections, each with a
// Summary row. Every line that names an account carries ColData[0].id, so the
// walk keys on that rather than trying to model the report's shape.
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
  const validId = (value: unknown) => typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const transactionIds = body?.transaction_ids;
  if (!validId(body?.batch_id) || !Array.isArray(transactionIds) || !transactionIds.length
      || transactionIds.length > 5000 || transactionIds.some((id: unknown) => !validId(id))
      || new Set(transactionIds).size !== transactionIds.length) {
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

  const { data: batch, error: batchError } = await supabase.from('card_import_batches')
    .select('id,source_id,status,origin,qbo_connection_id').eq('id', body.batch_id)
    .eq('company_entity_id', companyId).maybeSingle();
  if (batchError) return json({ error: 'Could not load the card batch.' }, 503);
  if (!batch) return json({ error: 'Card batch not found.' }, 404);
  if (!['draft', 'categorized'].includes(batch.status)) {
    return json({ error: 'Reopen the batch before requesting coding suggestions.' }, 409);
  }
  const { data: source, error: sourceError } = await supabase.from('card_sources')
    .select('id,display_name,source_type,ingest_mode,is_active,qbo_connection_id')
    .eq('id', batch.source_id).eq('company_entity_id', companyId).maybeSingle();
  if (sourceError) return json({ error: 'Could not load the card source.' }, 503);
  if (!source || !source.is_active || !['bank','card'].includes(source.source_type)) {
    return json({ error: 'Choose an active bank or card account before requesting suggestions.' }, 409);
  }
  const bankMode = source.source_type === 'bank';
  const connectionId = source.qbo_connection_id;
  if (!connectionId || (batch.qbo_connection_id && batch.qbo_connection_id !== connectionId)) {
    return json({ error: 'Bind the card source to the correct QuickBooks connection before requesting suggestions.' }, 409);
  }
  const { data: connection, error: connectionError } = await supabase.from('quickbooks_connections')
    .select('id').eq('id', connectionId).eq('company_entity_id', companyId)
    .eq('is_active', true).maybeSingle();
  if (connectionError) return json({ error: 'Could not verify the QuickBooks connection.' }, 503);
  if (!connection) return json({ error: 'The card source QuickBooks connection is not active.' }, 409);

  const selectedRows: any[] = [];
  // Keep each ID filter below URL/gateway limits and Supabase's row cap.
  for (let offset = 0; offset < transactionIds.length; offset += 100) {
    const { data: rows, error } = await supabase.from('card_transactions_v')
      .select('id,merchant_norm,card_name,description,amount,currency,status,qbo_account_id,origin,provider_status,accounting_treatment,txn_date')
      .eq('company_entity_id', companyId).eq('batch_id', batch.id)
      .in('id', transactionIds.slice(offset, offset + 100));
    if (error || !rows) return json({ error: 'Could not load the selected card transactions.' }, 503);
    selectedRows.push(...rows);
  }
  if (selectedRows.length !== transactionIds.length) {
    return json({ error: 'Some selected transactions are no longer in this batch. Reload it and try again.' }, 409);
  }
  if (selectedRows.some((row) => row.status !== 'uncoded' || row.qbo_account_id
      || !Number.isFinite(Number(row.amount)) || Number(row.amount) === 0 || (!bankMode && Number(row.amount) < 0) || row.currency !== 'USD'
      || row.origin !== batch.origin || (row.origin === 'plaid'
        && (row.provider_status !== 'posted' || (!bankMode && row.accounting_treatment !== 'purchase'))))) {
    return json({ error: bankMode
      ? 'Select uncoded, settled USD bank transactions. Reload this period to remove changed or unavailable rows.'
      : 'Card suggestions require uncoded purchase outflows. Save changes and review payments or pending rows separately.' }, 409);
  }
  const byStoredMerchant = new Map<string, Merchant>();
  for (const row of selectedRows) {
    if (!row.merchant_norm) continue;
    const direction = Number(row.amount)<0?'inflow':'outflow';
    const key = `${row.merchant_norm}||${row.card_name || ''}${bankMode?'||'+direction:''}`;
    const merchant = byStoredMerchant.get(key) || {
      merchant: row.merchant_norm, card_name: row.card_name || null,
      sample: row.description || '', count: 0, total: 0, anchor: '',
      ...(bankMode ? {direction} : {}),
    };
    merchant.count++;
    merchant.total += bankMode ? Math.abs(Number(row.amount)) : Number(row.amount);
    // History must precede the transaction. A row with no date anchors on
    // today, which can only widen what "before" means, never narrow it.
    const rowDate = /^\d{4}-\d{2}-\d{2}$/.test(String(row.txn_date || '')) ? String(row.txn_date) : isoDate(new Date());
    if (rowDate > merchant.anchor) merchant.anchor = rowDate;
    byStoredMerchant.set(key, merchant);
  }
  const merchants = [...byStoredMerchant.values()];
  const sourceName: string = source.display_name || 'card';
  if (!merchants.length) return json({ ok: true, suggestions: [] });

  // Bank suggestions include revenue and clearing/card destinations. The response
  // validator still requires a category type compatible with the movement.
  const { data: accountRows } = await supabase
    .from('quickbooks_accounts')
    .select('qbo_account_id, name, fully_qualified_name, account_type, account_sub_type')
    .eq('company_entity_id', companyId)
    .eq('connection_id', connectionId)
    .eq('is_active', true)
    .in('account_type', [
      'Expense', 'Other Expense', 'Cost of Goods Sold',
      'Fixed Asset', 'Other Current Asset',
      ...(bankMode ? ['Other Asset','Income','Other Income','Other Current Liability','Credit Card','Accounts Payable'] : []),
    ]);

  // Which accounts this company actually posts to, from the most recent P&L
  // SILO already holds. Absent one, every account is annotated null and the
  // prompt says nothing about usage rather than implying everything is dead.
  const { data: plRun } = await supabase
    .from('quickbooks_report_runs')
    .select('raw_response, start_date, end_date')
    .eq('company_entity_id', companyId)
    .eq('connection_id', connectionId)
    .in('report_name', ['ProfitAndLoss', 'ProfitAndLossDetail'])
    .eq('status', 'ok')
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const usage = plRun?.raw_response ? accountUsage(plRun.raw_response) : null;

  const accounts = (accountRows || []).map((a: any) => ({
    id: String(a.qbo_account_id),
    name: a.fully_qualified_name || a.name,
    type: a.account_type,
    sub: a.account_sub_type,
    used: usage ? (usage.get(String(a.qbo_account_id)) ?? 0) : null,
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
    .eq('connection_id', connectionId)
    .eq('is_active', true)
    .in('account_type', ['Accounts Receivable', 'Accounts Payable']);

  // The card feeds themselves settle to AP accounts ('Brex Account', 'Divvy
  // Account', 'Parker'), which are emphatically NOT related entities -- listing
  // them would invite the model to decline a card's own rows.
  const { data: cardAccts } = await supabase
    .from('card_sources')
    .select('credit_qbo_account_name')
    .eq('company_entity_id', companyId)
    .eq('qbo_connection_id', connectionId);
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
    .eq('connection_id', connectionId)
    .eq('is_active', true);
  const locations = (locationRows || []).map((l: any) => l.fully_qualified_name || l.name);

  // A sample of what humans have already confirmed, most-used first.
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
  const { data: ruleRows } = await ruleQuery;

  const examples = (ruleRows || [])
    .filter((r: any) => accounts.some((a) => a.name === r.qbo_account_name))
    .map((r: any) => ({
    merchant: r.pattern,
    account: r.qbo_account_name,
    location: locations.includes(r.qbo_location_name) ? r.qbo_location_name : null,
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

  // What this company did with these merchants before -- confirmed SILO
  // codings and the QBO ledger archive, 24 months back from each line.
  const eligibleById = new Map<string, ChartEntry>(accounts.map((a) => [a.id, { name: a.name, type: a.type }]));
  // The WHOLE active chart, not only the types offered for this mode, so a
  // live income account in card mode is labelled "not offered here" rather
  // than "removed from the chart".
  const { data: activeRows, error: activeError } = await supabase
    .from('quickbooks_accounts')
    .select('qbo_account_id, name, fully_qualified_name, account_type')
    .eq('company_entity_id', companyId)
    .eq('connection_id', connectionId)
    .eq('is_active', true);
  // A failed read is "state unknown", never "every account is removed".
  const activeById: Map<string, ChartEntry> | null = activeError ? null : new Map<string, ChartEntry>((activeRows || [])
    .map((a: any) => [String(a.qbo_account_id), { name: a.fully_qualified_name || a.name, type: a.account_type }]));
  const history = await loadHistory(supabase, companyId, connectionId, merchants, eligibleById, activeById);
  const historyLine = (m: Merchant) => {
    const ev = history.byKey.get(historyKey(m));
    return ev ? `- "${m.merchant}" (lines dated up to ${m.anchor}) -> ${ev.summary}` : null;
  };

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
        const sliceHistory = [...new Set(slices[i].map(historyLine).filter((l): l is string => !!l))];
        results[i] = await askModel(
          slices[i], accounts, locations, examples, sourceName, relatedEntities,
          companyName, cardNames, bankMode, sliceHistory);
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
          ...(bankMode ? {direction:m.direction,accounting_treatment:'unknown'} : {}),
          card_name: m.card_name ?? null,
          account_name: null,
          location_name: null,
          vendor_name: null,
          confidence: 0,
          reasoning: `Categorisation failed: ${result.message.slice(0, 160)}`,
          evidence: history.byKey.get(historyKey(m))?.summary,
          history_status: history.byKey.get(historyKey(m))?.status,
        });
      }
      return;
    }

    // Answers are matched back on the merchant AND card pair, since the same
    // merchant can legitimately appear twice with different cards.
    const key = (merchant: unknown, card: unknown, direction?: string) =>
      `${String(merchant ?? '')}||${card == null ? '' : String(card)}${bankMode?'||'+direction:''}`;
    const byMerchant = new Map((result || []).map((s) => [key(s.merchant, s.card_name, s.direction), s]));

    for (const m of slice) {
      const s = byMerchant.get(key(m.merchant, m.card_name, m.direction));
      const ev0 = history.byKey.get(historyKey(m));
      if (!s) {
        out.push({
          merchant: m.merchant,
          ...(bankMode ? {direction:m.direction,accounting_treatment:'unknown'} : {}),
          card_name: m.card_name ?? null,
          account_name: null,
          location_name: null,
          vendor_name: null,
          confidence: 0,
          reasoning: 'The model did not return a suggestion for this line.',
          evidence: ev0?.summary,
          history_status: ev0?.status,
        });
        continue;
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

      out.push({
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
    usage_from: usage ? `${plRun?.start_date} to ${plRun?.end_date}` : null,
    accounts_with_activity: usage ? accounts.filter((a) => (a.used ?? 0) > 0).length : null,
    history: history.stats,
    model: MODEL,
    errors: errors.length ? errors : undefined,
  });
});
