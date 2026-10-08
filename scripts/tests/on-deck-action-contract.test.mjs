import assert from 'node:assert/strict';
import { promptFor, validateDraft } from '../../supabase/functions/on-deck-prepare/draft.mjs';
import { run, preparationSummary } from '../on-deck-prepare.mjs';
import { prepareOne } from '../../supabase/functions/on-deck-prepare/provider.mjs';
const copy = { recommend: true, subject: 'Review search copy', summary: 'A hypothesis.', body: 'Prepared copy.', reason: 'Page exposure.', missing: [], optional_context: ['No test history is recorded.'], proposed_title: 'Classic tees | Example', proposed_meta_description: 'Explore classic tees.', tasks: [] };
const accepted = validateDraft(copy, 'seo');
assert.equal(accepted.proposed_title, copy.proposed_title);
assert.equal(accepted.missing.length, 0);
assert.equal(validateDraft({ ...copy, missing: ['Verify material claim'] }, 'seo').missing.length, 1);
assert.throws(() => validateDraft({ ...copy, proposed_title: undefined }, 'seo'), /invalid_proposed_title/);
assert.throws(() => validateDraft({ ...copy, optional_context: 'none' }, 'seo'), /invalid_optional/);
const blocked = { ...copy, missing: ['Verify the product claim'], proposed_title: '', proposed_meta_description: '' };
assert.equal(validateDraft(blocked, 'seo').missing.length, 1);
let stored;
await prepareOne({ proposal: { id: 'p', version: 1, company_entity_id: 'company', kind: 'seo', source: {} }, apiKey: 'fixture', requestId: 'fixture',
 db: { rpc: async (name,args) => { if(name.startsWith('ai_credit_')) return { error: {code:'PGRST202',message:'Could not find the function'} }; if(name==='on_deck_finish') stored=args; return {data:{claimed:true}}; }, from:()=>({select(){return this;},eq(){return this;},limit:async()=>({data:[{id:'event'}]})}) },
 fetcher:async()=>({ok:true,json:async()=>({stop_reason:'end_turn',usage:{input_tokens:100,output_tokens:100},content:[{type:'text',text:JSON.stringify(blocked)}]})}) });
assert.equal(stored.p_error,null); assert.deepEqual(stored.p_content.missing,blocked.missing);
const prompt = promptFor({ kind: 'seo', source: { context_evidence: { seo_work: [{ title: 'Saved earlier draft' }] } }, context_work: { state: 'resolved', resolution: 'Approved brief revision 3 confirms the material.' } });
assert.match(prompt, /Saved earlier draft/); assert.match(prompt, /revision 3/);
assert.match(prompt, /not automatically required/); assert.match(prompt, /Only facts whose absence prevents a safe/);
assert.equal(preparationSummary([{ status: 'needs_info' }, { status: 'ready' }, { status: 'failed' }]), 'Preparation: 1 ready, 1 need context, 1 failed, 0 queued');

// Actual worker orchestration, fake database/provider transport. The SQL suite
// separately exercises the real enrichment, staging and destination functions.
const company = 'test-company', now = new Date('2026-10-08T12:00:00Z');
let staged, status, prepared = 0;
const db = {
 async rpc(name, args) {
  assert.equal(args.p_company, company);
  if (name === 'on_deck_source_version') return { data: 'epoch' };
  if (name === 'on_deck_seo_facts') return { data: [{ url: 'https://example.test/tees', days: 26, impressions: 30000, clicks: 180, position: 7, last_day: '2026-10-06', inspection: { title: 'Tees', h1: 'Tees', fetched_at: '2026-10-07', http_status: 200 } }] };
  if (name === 'on_deck_context_evidence') { assert.equal(args.p_source.url, 'https://example.test/tees'); return { data: { seo_work: [{ title: 'Saved draft evidence' }] } }; }
  if (name === 'on_deck_stage') { staged = args.p_candidate; return { data: 'proposal' }; }
  throw new Error(name);
 },
 from(table) {
  let columns, filters = [], update;
  const q = { select(c) { columns = c; return q; }, eq(k,v) { filters.push([k,v]); return q; }, in(k,v) { filters.push([k,v]); return q; }, order() { return q; }, range() { return q; }, lt() { return q; }, gt() { return q; }, update(v) { update=v; return q; },
   async then(resolve) {
    if (table === 'on_deck_settings') { if(update) status=update.last_status; return resolve({ data: update ? [] : [{ company_entity_id: company, enabled: true, workflows: ['seo'] }] }); }
    assert.ok(filters.some(([k,v]) => k==='company_entity_id' && v===company));
    if (table === 'on_deck_proposals' && columns === '*') return resolve({ data: [{ id: 'proposal', company_entity_id: company, source: staged.source, context_work: { state: 'resolved', resolution: 'Documented evidence' } }] });
    if (table === 'on_deck_proposals' && columns === 'status') return resolve({ data: [{ status: 'needs_info' }] });
    return resolve({ data: [] });
   } }; return q;
 }
};
await run({ db, now, prepare: async ({proposal}) => { prepared++; assert.equal(proposal.source.context_evidence.seo_work[0].title, 'Saved draft evidence'); assert.equal(proposal.context_work.resolution, 'Documented evidence'); return 'prepared'; } });
assert.equal(prepared,1); assert.equal(status,'Preparation: 0 ready, 1 need context, 0 failed, 0 queued');
console.log('Action contract and actual worker wiring passed (provider mocked, no spend).');
