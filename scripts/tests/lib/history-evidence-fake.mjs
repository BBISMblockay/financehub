// A JavaScript stand-in for public.card_coding_history_evidence
// (20260923140000), so the categorizer suites can keep describing history as
// plain rows. It is NOT trusted on its own: card-coding-evidence-database
// runs the same fixtures through the real SQL and this function and requires
// identical output, so a change to one without the other fails a test.

// Mirrors public.normalize_merchant.
export function normalizeMerchant(text) {
  let t = String(text || '').toLowerCase();
  t = t.replace(/^(sq|tst|sp|py|paypal|pp|ppl|dd|ec)\s*\*+\s*/i, '');
  t = t.replace(/\s*\*+\s*[a-z0-9-]*[0-9][a-z0-9-]*\s*$/g, '');
  t = t.replace(/\s*[#*]?\s*[0-9]{2,}\s*$/g, '');
  t = t.replace(/\s+[a-z0-9]*[0-9][a-z0-9]{3,}\s*$/g, '');
  t = t.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t || null;
}

const LEDGER_TYPES = ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Fixed Asset', 'Other Asset', 'Other Current Asset', 'Income', 'Other Income'];
const monthsBefore = (iso, n) => {
  // PostgreSQL date - interval 'n months': the same day, clamped to the month's end.
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) - n;
  const year = Math.floor(total / 12), month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};
const words = (s) => ` ${s} `;
const contains = (hay, needle) => words(hay).includes(words(needle));

export function historyEvidence(records, { p_company, p_connection, p_pairs, p_per_key = 100, p_exclude = [] }) {
  const fail = (message) => ({ data: null, error: { message } });
  if (!Array.isArray(p_pairs) || p_pairs.length > 200) return fail('history evidence takes an array of at most 200 merchants');
  if (p_pairs.some((p) => !p?.key || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.before || '')) || !['any', 'inflow', 'outflow'].includes(p.direction ?? 'any'))) {
    return fail('each merchant needs a key, a before date (YYYY-MM-DD) and at most a direction');
  }
  if (!(records.quickbooks_connections || []).some((c) => c.id === p_connection && c.company_entity_id === p_company)) {
    return fail('connection does not belong to this company');
  }
  const per = Math.max(1, Math.min(p_per_key ?? 100, 500));
  const pairs = p_pairs.map((p, i) => ({ i, k: p.key, d: p.before, lo: monthsBefore(p.before, 24), dir: p.direction === 'any' ? null : p.direction ?? null }));
  const exclude = new Set(p_exclude || []);
  const out = [];

  const batches = new Map((records.card_import_batches || []).filter((b) => b.company_entity_id === p_company).map((b) => [b.id, b]));
  const sources = new Map((records.card_sources || []).filter((s) => s.company_entity_id === p_company).map((s) => [s.id, s]));
  const silo = (records.card_transactions || []).filter((t) => {
    if (t.company_entity_id !== p_company || t.status !== 'coded' || t.qbo_account_id == null || exclude.has(t.id)) return false;
    const b = batches.get(t.batch_id); const s = b && sources.get(b.source_id);
    if (!b || !s || (b.qbo_connection_id ?? s.qbo_connection_id) !== p_connection || b.status === 'voided') return false;
    return ['manual', 'rule'].includes(t.coding_source) || (t.coding_source === 'ai' && ['approved', 'posted'].includes(b.status));
  }).map((t) => ({ ...t, k: t.merchant_norm !== undefined ? t.merchant_norm : normalizeMerchant(t.clean_merchant ?? t.description) }));
  for (const p of pairs) {
    for (const t of silo) {
      if (t.k !== p.k || t.txn_date < p.lo || t.txn_date > p.d) continue;
      const amount = Number(t.amount);
      if (p.dir === 'outflow' && !(amount > 0)) continue;
      if (p.dir === 'inflow' && !(amount < 0)) continue;
      out.push({ i: p.i, src: 'silo', match: 'exact', rank: 1, account_id: t.qbo_account_id, account_name: t.qbo_account_name ?? null, date: t.txn_date, amount, tie: String(t.id) });
    }
  }

  const imports = new Set((records.qbo_history_imports || []).filter((im) => im.company_entity_id === p_company && im.qbo_connection_id === p_connection).map((im) => im.id));
  const lines = (records.qbo_history_lines || []).filter((h) => h.company_entity_id === p_company && imports.has(h.import_id)
    && h.row_kind === 'transaction' && LEDGER_TYPES.includes(h.account_type) && h.transaction_date);
  for (const p of pairs) {
    const best = new Map();
    for (const l of lines) {
      if (l.transaction_date < p.lo || l.transaction_date > p.d) continue;
      if (p.dir === 'outflow' && ['Income', 'Other Income'].includes(l.account_type)) continue;
      let rank = null;
      const payee = l.counterparty == null ? null : normalizeMerchant(l.counterparty);
      if (payee !== null) {
        if (payee === p.k) rank = 1;
        else if (Math.min(payee.length, p.k.length) >= 4 && (contains(payee, p.k) || contains(p.k, payee))) rank = 3;
      }
      const memo = l.memo == null ? null : normalizeMerchant(l.memo);
      if (memo !== null) {
        const r = memo === p.k ? 2 : p.k.length >= 4 && contains(memo, p.k) ? 3 : null;
        if (r !== null && (rank === null || r < rank)) rank = r;
      }
      if (rank === null) continue;
      // Overlapping QuickBooks snapshots hold the same line twice.
      const dup = [l.qbo_transaction_id ?? '\u0000', l.qbo_account_id, l.transaction_date, Number(l.natural_amount), l.counterparty ?? '\u0000'].join('|');
      const cur = best.get(dup);
      if (!cur || rank < cur.rank || (rank === cur.rank && String(l.id) < cur.tie)) {
        best.set(dup, { i: p.i, src: 'ledger', match: rank === 1 ? 'exact' : rank === 2 ? 'memo' : 'similar', rank,
          account_id: l.qbo_account_id, account_name: l.account_name, date: l.transaction_date, amount: Number(l.natural_amount), tie: String(l.id) });
      }
    }
    out.push(...best.values());
  }

  const groups = new Map();
  for (const r of out) { const g = `${r.i}|${r.src}`; groups.set(g, [...(groups.get(g) || []), r]); }
  const rows = [], totals = [];
  for (const [g, list] of [...groups.entries()].sort(([a], [b]) => {
    const [ai, as] = a.split('|'), [bi, bs] = b.split('|');
    return Number(ai) - Number(bi) || as.localeCompare(bs);
  })) {
    list.sort((a, b) => a.rank - b.rank || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0));
    const [i, src] = g.split('|');
    totals.push({ i: Number(i), src, total: list.length });
    for (const r of list.slice(0, per)) rows.push({ i: r.i, src: r.src, match: r.match, account_id: r.account_id, account_name: r.account_name, date: r.date, amount: r.amount });
  }
  return { data: { rows, totals, per_key: per }, error: null };
}
