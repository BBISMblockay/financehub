import test from 'node:test';
import assert from 'node:assert/strict';
import { previewDefaults } from '../../supabase/functions/windsor-broker/windsor-lib.mjs';
import { liveQuery, describeLiveFields } from '../../supabase/functions/mcp/windsor-live.mjs';
const connection = { id:'fixture', source:'generic_source', account_id:'own', company_entity_id:'company-a' };
const catalog = [
  {id:'account_id',type:'TEXT'}, {id:'date',type:'DATE'},
  ...['rate','average','balance','unique_count','orders'].map(id=>({id,type:'NUMERIC',table:'report'})),
  {id:'subject',type:'TEXT',table:'messages'},
];
function query(rows, extra = {}) {
  return liveQuery({ connection, fields:['account_id','subject','balance'], key:'synthetic',
    fetchImpl:async url=>new Response(JSON.stringify(String(url).endsWith('/fields') ? catalog : rows)), ...extra });
}
test('non-additive numerics are refused before any data request; counts still total',async()=>{
  for (const field of ['rate','average','balance','unique_count']) {
    let dataRequests=0;
    await assert.rejects(query([], {fields:['account_id',field],rollup:'total',fetchImpl:async url=>{
      if (!String(url).endsWith('/fields')) dataRequests++;
      return new Response(JSON.stringify(catalog));
    }}),/cannot be added up/);
    assert.equal(dataRequests,0);
  }
  // A plain numeric count keeps its rollup: refusal is about meaning, not about
  // giving up aggregation for every generic source.
  const totalled=await query([{account_id:'own',orders:2},{account_id:'own',orders:3}],
    {fields:['account_id','orders'],rollup:'total'});
  assert.equal(totalled.rows[0].orders,5); assert.equal(totalled.rollup,'total');
  assert.equal(totalled.rows[0].source_rows,2); assert.equal(totalled.completeness_status,'unverified');
  // A blank measure stays blank: blank is not zero.
  const blank=await query([{account_id:'own',orders:null}],{fields:['account_id','orders'],rollup:'total'});
  assert.equal(blank.rows[0].orders,null);
  const r=await query([{account_id:'own',subject:'A message',balance:null},{account_id:'own',subject:'Another',balance:0}]);
  assert.equal(r.rows[0].balance,null); assert.equal(r.rows[1].balance,0);
  assert.equal(r.persisted,false); assert.equal(r.completeness_status,'unverified');
  assert.equal(r.maybe_truncated,false);
});
test('empty is not zero, short responses remain uncertified, cap is flagged',async()=>{
  const r=await query([]); assert.deepEqual(r.rows,[]);assert.equal(r.result_status,'empty');
  assert.match(r.diagnostics.join(' '),/does not mean zero/);assert.equal(r.completeness_status,'unverified');
  const capped=await query(Array.from({length:200},()=>({account_id:'own',balance:1})));
  assert.equal(capped.maybe_truncated,true);
});
test('vendor errors cannot masquerade as empty successes; errors redact transport secrets',async()=>{
  await assert.rejects(query({data:[],error:'secret vendor error'}),/did not return data rows/);
  await assert.rejects(query([], {fetchImpl:async()=>{throw new Error('secret key in URL');}}),error=>!error.message.includes('secret'));
});
test('foreign and unattributed rows are rejected, including after display cap',async()=>{
  for (const row of [{account_id:'foreign',balance:99},{balance:99}]) {
    await assert.rejects(query([...Array.from({length:200},()=>({account_id:'own',balance:1})),row]),/identity/i);
  }
});
test('discovery reports groups as hints, preserves metadata, and never promises additivity',()=>{
  const r=describeLiveFields(catalog);
  assert.deepEqual(r.report_groups,['messages','report']);
  assert.equal(r.aggregation,'additive_fields_only');assert.match(r.compatibility,/not proof/);
  assert.deepEqual(r.additive_fields,['orders']);
});

test('access and field-combination refusals are distinct and contain no vendor details',async()=>{
  for (const [status, expected] of [[403,/refused access/],[422,/field\/report combination/],[429,/rate limited/]]) {
    await assert.rejects(query([], {fetchImpl:async()=>new Response('secret vendor detail',{status})}), error=>expected.test(error.message) && !error.message.includes('secret'));
  }
});

test('text-only source defaults include useful source fields from one report',()=>{
  assert.deepEqual(previewDefaults([{id:'account_id',type:'TEXT'}, {id:'subject',type:'TEXT',table:'messages'}, {id:'body',type:'TEXT',table:'messages'}, {id:'ticket',type:'TEXT',table:'tickets'}]), ['account_id','subject','body']);
});
