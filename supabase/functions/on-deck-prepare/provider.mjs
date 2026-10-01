import { promptFor, validateDraft, MODEL, MAX_OUTPUT_TOKENS } from './draft.mjs';
import { createCreditMeter, estimateInputTokens, usageFromResponse } from './ai-credit-lib.mjs';
const check = r => { if (r.error) throw new Error(r.error.message); return r.data; };
const rpc = async (db, name, args) => check(await db.rpc(name, args));
export async function prepareOne({ db, proposal, apiKey, fetcher = fetch, requestId = crypto.randomUUID() }) {
  // Validate prompt bound BEFORE reserving/spending. A bad source cannot loop paid calls.
  let prompt;
  try { prompt = promptFor(proposal); }
  catch {
    check(await db.from('on_deck_proposals').update({ status: 'failed', version: proposal.version + 1 }).eq('id', proposal.id).eq('version', proposal.version));
    return 'prompt_too_large';
  }
  // Customer AI credit is a SEPARATE limit from On Deck's operational cap and
  // is checked FIRST: an empty balance pauses preparation without taking an
  // On Deck attempt (which would hold $0.25 of the cap for nothing). `db` is
  // already the service-role client this function runs with.
  const credit = createCreditMeter({ db, requestId, companyId: proposal.company_entity_id, feature: 'on_deck', model: MODEL, sourceRef: proposal.id });
  const opened = await credit.open({ estInput: estimateInputTokens(prompt), maxOutput: MAX_OUTPUT_TOKENS });
  if (!opened.ok) return opened.reason === 'insufficient_credit' ? 'credit_exhausted' : opened.reason === 'duplicate' ? 'already_claimed' : 'credit_unavailable';
  let claim;
  try { claim = await rpc(db, 'on_deck_reserve', { p_id: proposal.id, p_version: proposal.version, p_request: requestId }); }
  catch (e) { await credit.settle({ usage: null, outcome: 'cancelled', error: 'on_deck_reserve_failed' }); throw e; }
  if (!claim.claimed) { await credit.settle({ usage: null, outcome: 'cancelled', error: 'not_claimed' }); return claim.reason || 'already_claimed'; }
  let content = null, input = null, output = null, error = null, usage = null, timedOut = false;
  try {
    const response = await fetcher('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_OUTPUT_TOKENS, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] }),
    });
    const body = await response.json();
    usage = usageFromResponse(body.usage);
    if (Number.isInteger(body.usage?.input_tokens) && Number.isInteger(body.usage?.output_tokens)) {
      input = body.usage.input_tokens; output = body.usage.output_tokens;
    }
    if (!response.ok) throw new Error(`provider_http_${response.status}`);
    if (body.stop_reason !== 'end_turn') throw new Error('incomplete_draft');
    const raw = body.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
    try { content = validateDraft(JSON.parse(raw), proposal.kind); } catch { throw new Error('invalid_draft'); }
  } catch (e) {
    // Never log provider bodies, prompts, customer copy or API credentials.
    timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    error = /^provider_http_\d+$|^incomplete_draft$|^invalid_draft$/.test(e.message) ? e.message : 'provider_outcome_unknown';
  }
  // If this write fails the hold remains. A later job closes it conservatively;
  // it does not retry the paid call or silently record $0.
  let finished = false;
  try {
    await rpc(db, 'on_deck_finish', { p_request: requestId, p_content: content, p_input: input, p_output: output, p_error: error });
    finished = true;
  } finally {
    // Only a prepared draft that was stored is charged to the customer's
    // credit. Everything else -- provider failure, invalid draft, timeout, a
    // failed write -- is free to them (On Deck's own cap still counts it).
    await credit.settle({ usage, outcome: !error && finished ? 'succeeded' : timedOut ? 'timed_out' : 'failed', error: error || (finished ? null : 'finish_failed') });
  }
  return error || 'prepared';
}
