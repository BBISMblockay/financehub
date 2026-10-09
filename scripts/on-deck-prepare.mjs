/** Opt-in preparation only. No authenticated approval or provider write tools. */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { curate } from './lib/on-deck-core.mjs';
const check = r => { if (r.error) throw Object.assign(new Error('database_request_failed'), { code: r.error.code }); return r.data; };
export function failureDiagnostic(error, stage, workflow) {
  const stages = ['reconcile', 'source_version', 'facts', 'mappings', 'source_recheck', 'screen', 'stage', 'screen_record', 'prepare', 'summary'];
  const known = ['source_limit_reached', 'source_changed_during_screening', 'edge_preparation_failed'];
  return { stage: stages.includes(stage) ? stage : 'unknown', workflow: ['restock','launch','seo','ads'].includes(workflow) ? workflow : null,
    code: /^[0-9A-Z]{5}$/.test(error?.code || '') ? error.code : known.includes(error?.message) ? error.message : 'unknown_error' };
}
const rpc = async (db, name, args) => check(await db.rpc(name, args));
async function pages(fetchPage) {
  const result = [];
  for (let offset = 0; offset < 100000; offset += 500) {
    const data = check(await fetchPage(offset)); result.push(...data);
    if (data.length < 500) return result;
  }
  throw new Error('source_limit_reached'); // Never rank a silently truncated feed.
}
// One bounded Edge invocation per proposal. The provider key never enters GitHub.
export async function prepareViaEdge({ db, proposal, requestId = randomUUID() }) {
  const { data, error } = await db.functions.invoke('on-deck-prepare', {
    body: { proposal_id: proposal.id, version: proposal.version, request_id: requestId },
    timeout: 120000,
  });
  if (error || typeof data?.outcome !== 'string') throw new Error('edge_preparation_failed');
  return data.outcome;
}
export async function run({ db, now = new Date(), prepare = prepareViaEdge }) {
  const settings = await pages(offset => db.from('on_deck_settings').select('*').eq('enabled', true).order('company_entity_id').range(offset, offset + 499));
  let failures = 0;
  for (const setting of settings) {
    const company = setting.company_entity_id;
    let stage = 'reconcile', workflow = null;
    try {
      // A timed-out process is never treated as a free request. No provider retry.
      const abandoned = check(await db.from('on_deck_attempts').select('id').eq('company_entity_id', company).eq('state', 'reserved').lt('created_at', new Date(+now - 30 * 60000).toISOString()));
      for (const a of abandoned) await rpc(db, 'on_deck_finish', { p_request: a.id, p_content: null, p_input: null, p_output: null, p_error: 'interrupted_outcome_unknown' });
      const due = !setting.last_screen_at || +now - new Date(setting.last_screen_at) >= 24 * 3600000 || new Date(setting.requested_at || 0) > new Date(setting.last_screen_at);
      if (due) {
        const facts = { products: [], mappings: [], launches: [], seo: [], ads: [], settings: setting, now }, versions = {};
        for (const kind of setting.workflows) {
          workflow = kind; stage = 'source_version';
          versions[kind] = await rpc(db, 'on_deck_source_version', { p_company: company, p_kind: kind });
          const endpoint = { restock: 'product', launch: 'launch', seo: 'seo', ads: 'ad' }[kind];
          stage = 'facts';
          facts[{ restock: 'products', launch: 'launches', seo: 'seo', ads: 'ads' }[kind]] = await pages(offset => db.rpc(`on_deck_${endpoint}_facts`, { p_company: company, p_offset: offset }));
          stage = 'mappings';
          if (kind === 'restock') facts.mappings = await pages(offset => db.from('shopify_product_skus').select('shop_domain,shopify_product_id,shopify_variant_id,sku,product_title,status:shopify_status').eq('company_entity_id', company).order('shop_domain').order('shopify_product_id').order('shopify_variant_id').range(offset, offset + 499));
          stage = 'source_recheck';
          if (versions[kind] !== await rpc(db, 'on_deck_source_version', { p_company: company, p_kind: kind })) throw new Error('source_changed_during_screening');
        }
        stage = 'screen'; workflow = null;
        const cooling = await pages(offset => db.from('on_deck_proposals').select('kind,source_key').eq('company_entity_id', company).in('status', ['completed', 'dismissed', 'screened']).gt('revisit_at', now.toISOString()).order('id').range(offset, offset + 499));
        facts.excludedKeys = new Set(cooling.map(p => `${p.kind}:${p.source_key}`));
        const result = curate(facts);
        const open = check(await db.from('on_deck_proposals').select('id,kind,source_key,status,user_edited,version,context_work').eq('company_entity_id', company).in('status', ['ready', 'needs_info', 'failed']));
        for (const p of open) {
          if (!p.user_edited && p.context_work?.state !== 'open' && !result.shortlist.some(c => c.kind === p.kind && c.key === p.source_key)) {
            check(await db.from('on_deck_proposals').update({ status: 'screened', revisit_at: new Date(+now + 86400000).toISOString(), version: p.version + 1, updated_at: now.toISOString() }).eq('id', p.id).eq('version', p.version));
          }
        }
        for (const candidate of result.shortlist) {
          stage = 'stage'; workflow = candidate.kind;
          candidate.source.context_evidence = await rpc(db, 'on_deck_context_evidence', { p_company: company, p_kind: candidate.kind, p_source: candidate.source });
          await rpc(db, 'on_deck_stage', { p_company: company, p_candidate: candidate, p_source_version: versions[candidate.kind] });
        }
        stage = 'screen_record'; workflow = null;
        check(await db.from('on_deck_settings').update({ last_screen_at: now.toISOString(), last_status: 'Screened strongest opportunities', diagnostics: result.diagnostics }).eq('company_entity_id', company));
      }
      stage = 'prepare'; workflow = null;
      const pending = check(await db.from('on_deck_proposals').select('*').eq('company_entity_id', company).in('status', ['preparing', 'revision']).order('created_at'));
      const outcomes = [];
      for (const p of pending) {
        workflow = p.kind;
        const outcome = await prepare({ db, proposal: p }); outcomes.push(outcome);
        if (outcome === 'stale') check(await db.from('on_deck_proposals').update({ status: 'failed', version: p.version + 1, updated_at: now.toISOString() }).eq('id', p.id).eq('version', p.version));
      }
      if (outcomes.length) {
        stage = 'summary'; workflow = null;
        const current = check(await db.from('on_deck_proposals').select('status').eq('company_entity_id', company).in('status', ['ready', 'needs_info', 'failed', 'preparing', 'revision']));
        check(await db.from('on_deck_settings').update({ last_status: outcomes.includes('credit_exhausted') ? 'Paused: workspace AI credit is used up' : outcomes.includes('budget_cap') ? 'Monthly preparation cap reached' : outcomes.includes('daily_cap') ? 'Daily safety cap reached' : preparationSummary(current) }).eq('company_entity_id', company));
      }
      console.log('On Deck company processed');
    } catch (error) {
      failures++;
      const diagnostic = failureDiagnostic(error, stage, workflow);
      const summary = `Preparation failed at ${diagnostic.stage}${diagnostic.workflow ? '/' + diagnostic.workflow : ''} (${diagnostic.code}); prior drafts and spend holds retained.`;
      console.error('On Deck preparation failed', JSON.stringify(diagnostic));
      try { check(await db.from('on_deck_settings').update({ last_status: summary }).eq('company_entity_id', company)); }
      catch { console.error('On Deck failure status could not be saved'); }
    }
  }
  if (failures) throw new Error(`${failures} company preparation run(s) failed`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.ON_DECK_ENABLED !== 'true') { console.log('On Deck worker disabled'); }
  else {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing GitHub Supabase URL or service-role credential');
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    await run({ db });
  }
}

export function preparationSummary(rows) {
 const count = status => rows.filter(r => r.status === status).length;
 return `Preparation: ${count('ready')} ready, ${count('needs_info')} need context, ${count('failed')} failed, ${count('preparing') + count('revision')} queued`;
}
