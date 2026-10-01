// AI credit metering, from inside an Edge Function.
//
// ONE COPY PER FUNCTION, IDENTICAL BY TEST: supabase/functions/silo-chat/,
// on-deck-prepare/ and payment-request-extract/ each bundle this file, because
// a function directory is what the deploy workflow ships. Change one, copy it
// to the others; scripts/tests/on-deck-edge.test.mjs fails if they differ.
//
// The database owns every decision (see 20261001120000_ai_credit_billing.sql):
// whether metering is on, the price, whether a hold fits, what is charged.
// This module only (a) estimates how big the next model call can be, in
// TOKENS -- it never sees a price -- and (b) carries the three calls:
//
//   open   -- before the FIRST model call. Takes the first hold.
//   step   -- before each LATER call. Records usage so far, grows the hold.
//   settle -- once, at the end. Success charges what was used (capped at the
//             hold); every other outcome is free.
//
// The client passed in MUST be a service-role client: the RPCs are revoked
// from anon and authenticated, so a browser cannot settle its own request at
// zero. It is never handed to a tool handler.
//
// Failure stance:
//   - The migration not applied yet (function missing) reads as `off`: the
//     AI feature behaves exactly as before. That is what makes rollout order
//     free of a flag day.
//   - Any other RPC error on OPEN refuses the request (`unavailable`): money
//     that cannot be checked is not spent.
//   - An RPC error on SETTLE leaves the hold in place; the sweep later closes
//     it as `interrupted` -- free to the customer. Fails in their favour.

/** Usage keys the database prices. Missing = 0. */
export const USAGE_KEYS = ['input', 'output', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h', 'web_search'];

/** One Messages API usage block -> the priced shape. Measurements only. */
export function usageFromResponse(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return {
    input: n(usage.input_tokens),
    output: n(usage.output_tokens),
    cache_read: n(usage.cache_read_input_tokens),
    cache_write: n(usage.cache_creation_input_tokens),
    cache_write_5m: n(usage.cache_creation?.ephemeral_5m_input_tokens),
    cache_write_1h: n(usage.cache_creation?.ephemeral_1h_input_tokens),
    web_search: n(usage.server_tool_use?.web_search_requests),
  };
}

/** Totals across calls. */
export function addUsage(list) {
  const out = Object.fromEntries(USAGE_KEYS.map((k) => [k, 0]));
  for (const u of list || []) {
    if (!u) continue;
    for (const k of USAGE_KEYS) out[k] += Number.isInteger(u[k]) ? u[k] : 0;
  }
  return out;
}

/** A deliberately HIGH estimate of a call's input tokens: ~3 bytes per token
 *  over everything sent (real text runs nearer 4; JSON and SQL nearer 3), plus
 *  a flat allowance per image. Over-estimating only makes a hold larger; the
 *  charge is always the measured usage. */
export function estimateInputTokens(payload) {
  const text = JSON.stringify(payload ?? '');
  const bytes = new TextEncoder().encode(text).length;
  const images = (text.match(/"type":"image"/g) || []).length;
  return Math.ceil(bytes / 3) + images * 2000;
}

function missingFunction(error) {
  const code = error?.code || '';
  const msg = String(error?.message || '');
  return code === 'PGRST202' || code === '42883' || /Could not find the function|does not exist/i.test(msg);
}

/**
 * @param {{ db: any, requestId: string, companyId: (string|null), userId?: (string|null),
 *           feature: string, model: string, sourceRef?: (string|null) }} ctx
 */
export function createCreditMeter(ctx) {
  /** @type {{ mode: string, opened: boolean, settled: boolean, enforced: boolean, held: number, result: any }} */
  const state = {
    mode: 'off', opened: false, settled: false, enforced: false, held: 0,
    result: null, // the settle result, once known
  };

  /** @param {{ estInput: number, maxOutput: number, maxWeb?: number, calls?: number }} args
   *  @returns {Promise<any>} */
  async function open({ estInput, maxOutput, maxWeb = 0, calls = 1 }) {
    if (!ctx.db) return { ok: true, mode: 'off' };
    const { data, error } = await ctx.db.rpc('ai_credit_open', {
      p_request: ctx.requestId, p_company: ctx.companyId, p_user: ctx.userId ?? null,
      p_feature: ctx.feature, p_model: ctx.model, p_est_input: estInput, p_max_output: maxOutput,
      p_max_web: maxWeb, p_calls_to_hold: calls, p_source_ref: ctx.sourceRef ?? null,
    });
    if (error) {
      if (missingFunction(error)) return { ok: true, mode: 'off' };
      return { ok: false, reason: 'unavailable' };
    }
    state.mode = data?.mode || 'off';
    if (data?.ok && state.mode !== 'off') {
      state.opened = true;
      state.enforced = state.mode === 'enforce';
      state.held = Number(data.held_micros || 0);
    }
    return data || { ok: false, reason: 'unavailable' };
  }

  /** Before a later call. Returns { ok } -- false means the hold could not
   *  grow; the caller stops investigating and spends what is already held on
   *  a final answer. Errors are treated as "could not grow", never as "go". */
  /** @param {{ usage: any, estInput: number, maxOutput: number, maxWeb?: number }} args
   *  @returns {Promise<any>} */
  async function step({ usage, estInput, maxOutput, maxWeb = 0 }) {
    if (!state.opened || state.settled) return { ok: true };
    const { data, error } = await ctx.db.rpc('ai_credit_step', {
      p_request: ctx.requestId, p_usage: usage, p_est_input: estInput,
      p_max_output: maxOutput, p_max_web: maxWeb,
    });
    if (error) return { ok: !state.enforced, reason: 'unavailable' };
    if (data?.held_micros != null) state.held = Number(data.held_micros);
    return data || { ok: !state.enforced };
  }

  /** Exactly once; later calls return the first result.
   *  @param {{ usage: any, outcome: string, error?: (string|null) }} args */
  async function settle({ usage, outcome, error = null }) {
    if (!state.opened) return { status: 'not_metered' };
    if (state.settled) return state.result;
    state.settled = true;
    const { data, error: rpcErr } = await ctx.db.rpc('ai_credit_settle', {
      p_request: ctx.requestId, p_usage: usage, p_outcome: outcome, p_error: error,
    });
    if (rpcErr || !data?.ok) {
      // The hold stays; the sweep closes it free. Report "pending", never $0.
      state.result = { status: 'pending' };
      return state.result;
    }
    state.result = describeSettle(data);
    return state.result;
  }

  return { open, step, settle, state };
}

/** What a person is shown about one operation. Customer dollars only. */
export function describeSettle(data) {
  if (!data) return { status: 'pending' };
  if (data.outcome !== 'succeeded') return { status: 'free', charged_micros: 0 };
  if (!data.enforced) {
    return data.customer_cost_micros == null
      ? { status: 'unpriced' }
      : { status: 'preview', charged_micros: Number(data.customer_cost_micros) };
  }
  return { status: 'charged', charged_micros: Number(data.charged_micros) };
}
