/** Opt-in preparation only. No authenticated approval or provider write tools. */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { curate, promptFor, validateDraft, MODEL, MAX_OUTPUT_TOKENS } from './lib/on-deck-core.mjs';
const check = r => { if (r.error) throw new Error(r.error.message); return r.data; };
const rpc = async (db, name, args) => check(await db.rpc(name, args));
async function pages(fetchPage) {
  const result = [];
  for (let offset = 0; offset < 100000; offset += 500) {
    const data = check(await fetchPage(offset)); result.push(...data);
    if (data.length < 500) return result;
  }
  throw new Error('source_limit_reached'); // Never rank a silently truncated feed.
}
export async function prepareOne({ db, proposal, apiKey, fetcher = fetch, requestId = randomUUID() }) {
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
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: 'user', content: prompt }] }),
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
export async function run({ db, apiKey, now = new Date(), fetcher = fetch }) {
  const settings = await pages(offset => db.from('on_deck_settings').select('*').eq('enabled', true).order('company_entity_id').range(offset, offset + 499));
  let failures = 0;
  for (const setting of settings) {
    const company = setting.company_entity_id;
    try {
      // A timed-out process is never treated as a free request. No provider retry.
      const abandoned = check(await db.from('on_deck_attempts').select('id').eq('company_entity_id', company).eq('state', 'reserved').lt('created_at', new Date(+now - 30 * 60000).toISOString()));
      for (const a of abandoned) await rpc(db, 'on_deck_finish', { p_request: a.id, p_content: null, p_input: null, p_output: null, p_error: 'interrupted_outcome_unknown' });
      const due = !setting.last_screen_at || +now - new Date(setting.last_screen_at) >= 24 * 3600000 || new Date(setting.requested_at || 0) > new Date(setting.last_screen_at);
      if (due) {
        const facts = { products: [], mappings: [], launches: [], seo: [], ads: [], settings: setting, now }, versions = {};
        for (const kind of setting.workflows) {
          versions[kind] = await rpc(db, 'on_deck_source_version', { p_company: company, p_kind: kind });
          const endpoint = { restock: 'product', launch: 'launch', seo: 'seo', ads: 'ad' }[kind];
          facts[{ restock: 'products', launch: 'launches', seo: 'seo', ads: 'ads' }[kind]] = await pages(offset => db.rpc(`on_deck_${endpoint}_facts`, { p_company: company, p_offset: offset }));
          if (kind === 'restock') facts.mappings = await pages(offset => db.from('shopify_product_skus').select('shop_domain,shopify_product_id,shopify_variant_id,sku,product_title,status').eq('company_entity_id', company).order('shop_domain').order('shopify_product_id').order('shopify_variant_id').range(offset, offset + 499));
          if (versions[kind] !== await rpc(db, 'on_deck_source_version', { p_company: company, p_kind: kind })) throw new Error('source_changed_during_screening');
        }
        const cooling = await pages(offset => db.from('on_deck_proposals').select('kind,source_key').eq('company_entity_id', company).in('status', ['completed', 'dismissed', 'screened']).gt('revisit_at', now.toISOString()).order('id').range(offset, offset + 499));
        facts.excludedKeys = new Set(cooling.map(p => `${p.kind}:${p.source_key}`));
        const result = curate(facts);
        const open = check(await db.from('on_deck_proposals').select('id,kind,source_key,status,user_edited,version').eq('company_entity_id', company).in('status', ['ready', 'needs_info', 'failed']));
        for (const p of open) {
          if (!p.user_edited && !result.shortlist.some(c => c.kind === p.kind && c.key === p.source_key)) {
            check(await db.from('on_deck_proposals').update({ status: 'screened', revisit_at: new Date(+now + 86400000).toISOString(), version: p.version + 1, updated_at: now.toISOString() }).eq('id', p.id).eq('version', p.version));
          }
        }
        for (const candidate of result.shortlist) await rpc(db, 'on_deck_stage', { p_company: company, p_candidate: candidate, p_source_version: versions[candidate.kind] });
        check(await db.from('on_deck_settings').update({ last_screen_at: now.toISOString(), last_status: 'Screened strongest opportunities', diagnostics: result.diagnostics }).eq('company_entity_id', company));
      }
      const pending = check(await db.from('on_deck_proposals').select('*').eq('company_entity_id', company).in('status', ['preparing', 'revision']).order('created_at'));
      const outcomes = [];
      for (const p of pending) {
        const outcome = await prepareOne({ db, proposal: p, apiKey, fetcher }); outcomes.push(outcome);
        if (outcome === 'stale') check(await db.from('on_deck_proposals').update({ status: 'failed', version: p.version + 1, updated_at: now.toISOString() }).eq('id', p.id).eq('version', p.version));
      }
      if (outcomes.length) check(await db.from('on_deck_settings').update({ last_status: outcomes.includes('budget_cap') ? 'Monthly preparation cap reached' : outcomes.includes('daily_cap') ? 'Daily safety cap reached' : `Preparation: ${outcomes.filter(x => x === 'prepared').length} ready, ${outcomes.filter(x => x !== 'prepared').length} held or failed` }).eq('company_entity_id', company));
      console.log('On Deck company processed');
    } catch {
      failures++;
      await db.from('on_deck_settings').update({ last_status: 'Preparation failed; prior drafts and spend holds retained. Retry after resolving source access or freshness.' }).eq('company_entity_id', company);
      console.error('On Deck company preparation failed');
    }
  }
  if (failures) throw new Error(`${failures} company preparation run(s) failed`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.ON_DECK_ENABLED !== 'true') { console.log('On Deck worker disabled'); }
  else {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) throw new Error('Missing preparation credentials');
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    await run({ db, apiKey: ANTHROPIC_API_KEY });
  }
}
