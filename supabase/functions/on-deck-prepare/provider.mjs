import { promptFor, validateDraft, MODEL, MAX_OUTPUT_TOKENS } from './draft.mjs';
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
  const claim = await rpc(db, 'on_deck_reserve', { p_id: proposal.id, p_version: proposal.version, p_request: requestId });
  if (!claim.claimed) return claim.reason || 'already_claimed';
  let content = null, input = null, output = null, error = null;
  try {
    const response = await fetcher('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_OUTPUT_TOKENS, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] }),
    });
    const body = await response.json();
    if (Number.isInteger(body.usage?.input_tokens) && Number.isInteger(body.usage?.output_tokens)) {
      input = body.usage.input_tokens; output = body.usage.output_tokens;
    }
    if (!response.ok) throw new Error(`provider_http_${response.status}`);
    if (body.stop_reason !== 'end_turn') throw new Error('incomplete_draft');
    const raw = body.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
    try { content = validateDraft(JSON.parse(raw), proposal.kind); } catch { throw new Error('invalid_draft'); }
  } catch (e) {
    // Never log provider bodies, prompts, customer copy or API credentials.
    error = /^provider_http_\d+$|^incomplete_draft$|^invalid_draft$/.test(e.message) ? e.message : 'provider_outcome_unknown';
  }
  // If this write fails the hold remains. A later job closes it conservatively;
  // it does not retry the paid call or silently record $0.
  await rpc(db, 'on_deck_finish', { p_request: requestId, p_content: content, p_input: input, p_output: output, p_error: error });
  return error || 'prepared';
}
