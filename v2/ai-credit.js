// window.SiloAICredit -- the one place a page turns AI-credit data into words.
//
// Shared by /v2/billing.html (the full card) and /v2/silo-chat.html (the
// compact balance and the per-answer cost), so "pending", "unavailable",
// "not switched on" and "$0.00" are told apart the same way everywhere:
//
//   unavailable  -- the summary could not be read (migration not applied, or
//                   an error). NEVER rendered as a balance.
//   unconfigured -- billing for AI credit is not switched on for SILO yet.
//   preview      -- usage is priced and shown, but nothing is deducted.
//   active       -- real balance. A null balance means no credit has ever
//                   been granted, which is not the same as $0.00 remaining.
//
// Amounts arrive as integer micro-USD of CUSTOMER-priced credit. Nothing here
// ever sees a provider cost or a multiplier; the database does not send one.
(function (root) {
  'use strict';

  function fmtMicros(micros, opts) {
    if (micros == null || !isFinite(Number(micros))) return '—';
    var n = Number(micros);
    if (n > 0 && n < 10000 && !(opts && opts.exact)) return '<$0.01';
    var dollars = n / 1e6;
    var fmt;
    try {
      fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch (_) { return '$' + dollars.toFixed(2); }
    return fmt.format(dollars);
  }

  // Normalise an RPC result (or failure) into a single state the UI renders.
  function describe(summary, error) {
    if (error || !summary || typeof summary !== 'object' || Array.isArray(summary) || !summary.state) {
      return { state: 'unavailable', label: 'Unavailable', note: 'AI credit could not be loaded right now.' };
    }
    if (summary.state === 'unconfigured') {
      return { state: 'unconfigured', label: 'Not switched on', note: "AI credit isn't switched on for this workspace yet. AI features work as before." };
    }
    var base = {
      state: summary.state,
      planIncluded: summary.plan_included_micros,
      available: summary.available_micros,
      included: summary.included_micros,
      purchased: summary.purchased_micros,
      pending: summary.pending_micros,
      neverGranted: summary.available_micros == null,
    };
    if (summary.state === 'preview') {
      base.label = 'Preview';
      base.note = 'Usage is shown at customer prices, but nothing is deducted yet.';
    } else {
      base.label = base.neverGranted ? 'No credit yet' : 'Available';
      base.note = base.neverGranted
        ? 'No AI credit has been added to this workspace yet. Included credit arrives when a subscription payment is received.'
        : '';
      base.exhausted = !base.neverGranted && Number(summary.available_micros) <= 0;
    }
    return base;
  }

  // What one Ask SILO answer cost. `credit` is the `ai_credit` field of the
  // response; absent on answers from before credit existed.
  function describeCharge(credit) {
    if (!credit || !credit.status) return null;
    switch (credit.status) {
      case 'charged': return { text: fmtMicros(credit.charged_micros) + ' AI credit', tone: 'info' };
      case 'preview': return { text: 'Preview: ' + fmtMicros(credit.charged_micros) + ' (not deducted)', tone: 'info' };
      case 'free': return { text: 'No charge', tone: 'pos' };
      case 'pending': return { text: 'AI credit: settling', tone: 'info' };
      case 'unpriced': return { text: 'AI credit: not priced', tone: 'info' };
      default: return null; // not_metered: say nothing
    }
  }

  // How close the workspace is to running out, for the pill's colour.
  //   ok      -- plenty left (green)
  //   caution -- under 25% of the plan's monthly included credit, or under
  //              $10, whichever is higher (yellow)
  //   low     -- under 10%, or under $2, whichever is higher (red)
  //   out     -- nothing left (red)
  // Only a real, enforced balance has a level. A preview deducts nothing, and
  // a workspace that has never been granted credit is not "low", it is new.
  var CAUTION = { share: 0.25, floor: 10000000 };
  var LOW = { share: 0.10, floor: 2000000 };
  function level(d) {
    if (!d || d.state !== 'active' || d.neverGranted) return null;
    var available = Number(d.available);
    if (!isFinite(available)) return null;
    if (available <= 0) return 'out';
    var plan = Number(d.planIncluded);
    var bar = function (t) { return Math.max(t.floor, isFinite(plan) && plan > 0 ? plan * t.share : 0); };
    if (available < bar(LOW)) return 'low';
    if (available < bar(CAUTION)) return 'caution';
    return 'ok';
  }

  async function load(sb) {
    try {
      var res = await sb.rpc('ai_credit_summary');
      if (res.error) return { summary: null, error: res.error };
      return { summary: res.data, error: null };
    } catch (e) {
      return { summary: null, error: e };
    }
  }

  var api = { fmtMicros: fmtMicros, describe: describe, describeCharge: describeCharge, level: level, load: load };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SiloAICredit = api;
})(typeof window !== 'undefined' ? window : globalThis);
