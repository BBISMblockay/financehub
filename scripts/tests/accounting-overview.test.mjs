import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../v2/accounting-overview.js',import.meta.url),'utf8');
function api(text = source) { const window = {}; vm.runInNewContext(text,{window,Date,Map,Number,Array,Object,Promise,Error,String}); return {api:window.SiloAccountingOverview,window}; }
const {api:A} = api();
const facts = () => ({ today:'2026-11-12',settings:{bookkeeping_mode:'silo'},opening:null,accountCount:0,qbo:[],bankAccounts:[],bankConnections:[],sources:[],batches:[],claims:[],journals:[] });
const assess = f => A.assess(f,{period:'2026-11'});
test('unknown, empty and reporting-only are distinct',() => {
  const absent = assess({});
  assert.equal(absent.opening.status,'unknown'); assert.equal(absent.qbo.count,null); assert.equal(absent.queues.count,null);
  const empty = assess(facts()); assert.equal(empty.opening.status,'not_started'); assert.equal(empty.queues.count,0);
  assert.equal(assess({...facts(),settings:{bookkeeping_mode:'qbo'}}).mode,'reporting_only');
  assert.equal(assess({...facts(),settings:A.UNMEASURED}).mode,'unknown');
});
test('currencies and liabilities stay separate, missing balances never become zero',() => {
  const rows = [{iso_currency_code:'USD',type:'depository',current_balance:'100'}, {iso_currency_code:'CAD',type:'depository',current_balance:200}, {iso_currency_code:'USD',type:'credit',current_balance:40}, {iso_currency_code:'USD',type:'depository',current_balance:null}, {type:'depository',current_balance:300}];
  const groups = A.balances(rows);
  assert.equal(groups.length,4); assert.equal(groups[0].total,null); assert.equal(groups[0].missing,1);
  assert.equal(groups[1].total,200); assert.equal(groups[2].total,40); assert.equal(groups[3].total,null);
  assert.equal(A.balances([{iso_currency_code:'USD',type:'depository',current_balance:''}])[0].total,null);
});
test('month queues use inclusive period overlap and distinguish categorization from delivery',() => {
  const model = assess({...facts(),batches:[{id:'a',txn_count:1,period_start:'2026-10-01',period_end:'2026-11-30',status:'categorized'}, {id:'b',txn_count:1,entry_date:'2026-11-30',status:'approved'}, {id:'c',txn_count:1,entry_date:'2026-12-01',status:'posted'}, {id:'d',txn_count:1,entry_date:'2026-11-03',status:'draft'}]});
  assert.equal(model.queues.count,3); assert.equal(model.queues.categorized,1); assert.equal(model.queues.posted,0); assert.equal(model.queues.needsReview,2);
  assert.throws(() => A.periodBounds('2026-13')); assert.equal(A.periodBounds('2024-02').end,'2024-02-29');
});
test('bank mapping needs the real balancing account; unavailable connections remain unknown',() => {
  const m = assess({...facts(),bankAccounts:[{id:'a',source_id:'s'}],bankConnections:A.UNMEASURED,sources:[{id:'s'}]});
  assert.equal(m.banks.state,'unknown'); assert.equal(m.banks.rows[0].connectionStatus,'unknown'); assert.equal(m.banks.unmapped,1);
});
test('journal totals count full month but show latest eight rows',() => {
  const rows = Array.from({length:12},(_,i) => ({id:String(i),entry_date:'2026-11-'+String(i+1).padStart(2,'0'),status:'draft',kind:'journal_adjustment'}));
  const m = assess({...facts(),journals:rows});
  assert.equal(m.journals.count,12); assert.equal(m.journals.rows.length,8); assert.equal(m.journals.rows[0].entry_date,'2026-11-12');
});
function client({failure, denied = false, cap = 500, companyChanges = false, failAfter = 0, nullCount = false} = {}) {
  const calls = [], company = {id:'company-a'}, tables = {accounting_settings:{bookkeeping_mode:'silo'},accounting_opening_balances:null,accounting_accounts:[],plaid_connections:[],plaid_accounts:[],card_sources:[],card_import_batches_v:[],quickbooks_journal_postings:[],accounting_journal_register:[]};
  let resolutions = 0;
  const config = {async ensureActiveCompany() { calls.push(['resolve']); return companyChanges && resolutions++ ? {id:'company-b'} : company; }};
  const db = {
    auth:{async getSession() { calls.push(['session']); return {data:{session:{user:{email:'synthetic@example.invalid'}}}}; }},
    async rpc(name) { calls.push(['rpc',name]); return {data:name === 'can_manage_journal_entries' ? !denied : name === 'is_exec_or_owner' ? false : name === 'silo_business_today' ? '2026-11-12' : []}; },
    from(table) {
      const log = ['table',table]; calls.push(log);
      let from = 0, to = 499, single = false, head = false; const filters = [];
      const q = {
        select(columns,options) { log.push(['select',columns,options]); head = options?.head; return q; },
        eq(column,value) { log.push(['eq',column,value]); return q; },
        in(column,values) { filters.push(r => values.includes(r[column])); return q; },
        order(column) { log.push(['order',column]); return q; },
        gte(column,value) { filters.push(r => r[column] >= value); return q; },
        lte(column,value) { filters.push(r => r[column] <= value); return q; },
        range(a,b) { from=a; to=Math.min(b,a+cap-1); log.push(['range',a,b]); return q; },
        maybeSingle() { single=true; return q; },
        then(resolve,reject) {
          const rows = Array.isArray(tables[table]) ? tables[table].filter(r => filters.every(fn => fn(r))) : [];
          const response = failure === table && from >= failAfter ? {error:{message:'Synthetic failure'}} : {data:single ? tables[table] : head ? null : rows.slice(from,to+1),count:nullCount ? null : rows.length};
          return Promise.resolve(response).then(resolve,reject);
        }
      }; return q;
    }
  };
  return {db,config,calls,tables};
}
test('real loader scopes every table and paginates beyond both 500 and a lower server cap',async () => {
  const c = client({cap:137}); c.tables.plaid_accounts = Array.from({length:1101},(_,i) => ({id:String(i),type:'credit'}));
  const m = await A.load(c); assert.equal(m.banks.count,1101); assert.equal(m.period,'2026-11');
  for (const call of c.calls.filter(c => c[0] === 'table')) assert.ok(call.some(v => Array.isArray(v) && v[0] === 'eq' && v[1] === 'company_entity_id' && v[2] === 'company-a'));
  assert.equal(c.calls[0][0],'resolve'); assert.ok(c.calls.some(c => c[0] === 'rpc' && c[1] === 'accounting_qbo_connections'));
  assert.ok(!c.calls.some(c => c[1] === 'quickbooks_connections'));
});
test('failed section does not erase independent data or falsely show zero',async () => {
  const c = client({failure:'card_import_batches_v'}); const m = await A.load(c);
  assert.equal(m.queues.count,null); assert.equal(m.journals.count,0); assert.equal(m.errors[0].source,'batches');
});
test('finance denial and missing company stop before financial reads',async () => {
  const c = client({denied:true}); await assert.rejects(A.load(c),/Finance access/); assert.equal(c.calls.filter(c => c[0] === 'table').length,0);
  const d = client(); d.config.ensureActiveCompany = async () => null; await assert.rejects(A.load(d),/Select a company/); assert.equal(d.calls.length,0);
});
test('company change discards a mixed snapshot',async () => { await assert.rejects(A.load(client({companyChanges:true})),/Company changed/); });
test('boot authenticates, loads then mounts, and refresh reads again',async () => {
  const {api:B,window} = api(), c = client(), models = [], mounts = [];
  window.SiloChrome = {mount:options => mounts.push(options)};
  const controller = await B.boot({...c,active:'finance/accounting-home',onModel:m => models.push(m)});
  assert.equal(c.calls[0][0],'session'); assert.equal(models.length,1); assert.equal(mounts.length,1); assert.equal(controller.company.id,'company-a');
  await controller.refresh('2026-10'); assert.equal(models[1].period,'2026-10');
});
test('unauthenticated boot redirects without querying finance',async () => {
  const {api:B,window} = api(), c = client(); window.location = {pathname:'/v2/accounting.html',search:'?period=2026-11'};
  c.db.auth.getSession = async () => ({data:{session:null}});
  assert.equal(await B.boot(c),null); assert.match(window.location.href,/login/); assert.equal(c.calls.length,0);
});
test('mutation checks catch zero coercion and missing tenant filters',async () => {
  const badNumber = api(source.replace("typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')","true")).api;
  assert.equal(badNumber.balances([{iso_currency_code:'USD',current_balance:null}])[0].total,0);
  assert.notEqual(badNumber.balances([{iso_currency_code:'USD',current_balance:null}])[0].total,A.balances([{iso_currency_code:'USD',current_balance:null}])[0].total);
  const badScope = api(source.replace(".eq('company_entity_id',companyId)",'')).api, c = client(); await badScope.load(c);
  assert.ok(c.calls.filter(c => c[0] === 'table').some(c => !c.some(v => Array.isArray(v) && v[0] === 'eq')));
});

test('later page failure discards earlier rows; missing exact counts are Unknown',async () => {
  const c = client({failure:'plaid_accounts',failAfter:500});
  c.tables.plaid_accounts = Array.from({length:501},(_,i) => ({id:String(i)}));
  const m = await A.load(c); assert.equal(m.banks.count,null); assert.equal(m.banks.rows.length,0);
  const incomplete = await A.load(client({nullCount:true})); assert.equal(incomplete.queues.count,null); assert.equal(incomplete.accounts.count,null);
});
test('boot reports failed initial load only once and never mounts unauthorized chrome',async () => {
  const {api:B,window} = api(), c = client({denied:true}); let errors = 0, mounts = 0;
  window.SiloChrome = {mount() { mounts++; }};
  await assert.rejects(B.boot({...c,onError() { errors++; }}),/Finance access/);
  assert.equal(errors,1); assert.equal(mounts,0);
});
test('controller ignores a stale refresh that resolves after a newer month',async () => {
  const {api:B,window} = api(), c = client(), rendered = [];
  window.SiloChrome = {mount() {}};
  const controller = await B.boot({...c,onModel:m => rendered.push(m.period)});
  let release;
  const original = c.config.ensureActiveCompany;
  let paused = false;
  c.config.ensureActiveCompany = async () => {
    if (!paused) { paused = true; await new Promise(resolve => { release = resolve; }); }
    return original();
  };
  const old = controller.refresh('2026-09');
  await controller.refresh('2026-10'); release();
  assert.equal(await old,null); assert.deepEqual(rendered,['2026-11','2026-10']);
});

test('mapping requires a balancing account on a known active QBO connection',() => {
  const base = {...facts(),bankAccounts:[{id:'a',source_id:'s'}],qbo:[{id:'qbo'}],sources:[{id:'s',credit_qbo_account_id:'cash',qbo_connection_id:'qbo'}]};
  assert.equal(assess(base).banks.rows[0].mapped,true);
  assert.equal(assess({...base,sources:[{id:'s',credit_qbo_account_id:'cash'}]}).banks.rows[0].mapped,false);
  assert.equal(assess({...base,sources:[{id:'s',credit_qbo_account_id:'cash',qbo_connection_id:'disconnected'}]}).banks.rows[0].mapped,false);
  assert.equal(assess({...base,qbo:[]}).banks.unmapped,1);
  const failed = assess({...base,qbo:A.UNMEASURED});
  assert.equal(failed.banks.rows[0].mapped,null); assert.equal(failed.banks.unmapped,null); assert.equal(failed.banks.state,'unknown');
});
test('stale company reconciliation blocks before reads and discards a later snapshot',async () => {
  for (const staleAt of [1,2]) {
    const c = client(); let resolutions = 0;
    c.config.ensureActiveCompany = async () => ({id:'company-a',_staleReconcile:++resolutions === staleAt});
    await assert.rejects(A.load(c),/Company could not be reconciled/);
    if (staleAt === 1) assert.equal(c.calls.length,0);
  }
});
test('mutation evidence: categorized review, connection mapping and both stale guards',async () => {
  const f = {...facts(),batches:[{id:'a',txn_count:1,entry_date:'2026-11-12',status:'categorized'}]};
  const badQueue = api(source.replace("if (!['draft','categorized'].includes(row.status)) continue;", "if (row.status !== 'draft') continue;")).api;
  assert.equal(A.assess(f,{period:'2026-11'}).queues.needsReview,1);
  assert.equal(badQueue.assess(f,{period:'2026-11'}).queues.needsReview,0);
  const badMap = api(source.replace(" && source.qbo_connection_id && facts.qbo.some(qbo => qbo.id === source.qbo_connection_id)",'')).api;
  const mf = {...facts(),bankAccounts:[{id:'a',source_id:'s'}],sources:[{id:'s',credit_qbo_account_id:'cash'}]};
  assert.equal(A.assess(mf,{period:'2026-11'}).banks.unmapped,1);
  assert.equal(badMap.assess(mf,{period:'2026-11'}).banks.unmapped,0);
  for (const [guard,staleAt] of [["    if (company._staleReconcile) throw new Error('Company could not be reconciled. Refresh to retry.');",1],["    if (current?._staleReconcile) throw new Error('Company could not be reconciled. Refresh to retry.');",2]]) {
    assert.ok(source.includes(guard));
    const mutant = api(source.replace(guard,'')).api, c = client(); let resolutions = 0;
    c.config.ensureActiveCompany = async () => ({id:'company-a',_staleReconcile:++resolutions === staleAt});
    // Removing either specific guard incorrectly permits a snapshot. The
    // preceding regression requires this same input to reject.
    assert.equal((await mutant.load(c)).company.id,'company-a');
  }
});

test('review count excludes reporting-only, pre-cutover and empty imports but retains records',() => {
  const batch = {id:'b',status:'categorized',txn_count:2,period_start:'2026-11-01',period_end:'2026-11-30'};
  const model = (b,settings={bookkeeping_mode:'silo'}) => assess({...facts(),settings,batches:[b]});
  assert.equal(model(batch).queues.needsReview,1);
  assert.equal(model(batch,{bookkeeping_mode:'qbo'}).queues.needsReview,0);
  assert.equal(model({...batch,source_posting_start_on:'2026-12-01'}).queues.needsReview,0);
  assert.equal(model({...batch,source_posting_start_on:'2026-11-15'}).queues.needsReview,1);
  assert.equal(model({...batch,txn_count:0}).queues.needsReview,0);
  assert.equal(model({...batch,txn_count:null}).queues.needsReview,0);
  assert.equal(model(batch,null).queues.needsReview,1,'missing settings row retains database silo default');
  const history = model({...batch,source_posting_start_on:'2026-12-01'});
  assert.equal(history.queues.count,1); assert.equal(history.queues.rows.length,1);
  assert.equal(model(batch,A.UNMEASURED).queues.needsReview,null);
});
test('approved unresolved recovery survives reporting-only and cutover; failed claims read is Unknown',() => {
  const batch = {id:'b',status:'approved',txn_count:2,entry_date:'2026-11-30',source_posting_start_on:'2026-12-01'};
  const f = {...facts(),settings:{bookkeeping_mode:'qbo'},batches:[batch]};
  assert.equal(assess(f).queues.needsReview,0);
  for (const status of ['submitting','unknown']) assert.equal(assess({...f,claims:[{source_ref:'b',status}]}).queues.needsReview,1);
  assert.equal(assess({...f,claims:[{source_ref:'other',status:'unknown'}]}).queues.needsReview,0);
  assert.equal(assess({...f,claims:A.UNMEASURED}).queues.needsReview,null);
  assert.equal(assess({...f,claims:[{source_ref:'b',status:'failed'}]}).queues.needsReview,0);
});
test('real loader reads scoped active recovery claims and fails safely',async () => {
  const c = client(); c.tables.card_import_batches_v=[{id:'b',txn_count:1,status:'approved',entry_date:'2026-11-30'}];
  c.tables.quickbooks_journal_postings=[{id:'claim',source_ref:'b',status:'unknown'}];
  assert.equal((await A.load(c)).queues.needsReview,1);
  const q = c.calls.find(c => c[1] === 'quickbooks_journal_postings');
  assert.ok(q.some(v => Array.isArray(v) && v[0] === 'eq' && v[1] === 'source' && v[2] === 'card_import'));
  const failed = client({failure:'quickbooks_journal_postings'}); failed.tables.card_import_batches_v=c.tables.card_import_batches_v;
  const m = await A.load(failed); assert.equal(m.queues.needsReview,null); assert.equal(m.queues.count,1); assert.equal(m.errors[0].source,'claims');
});
test('mutation evidence catches reporting-only, cutover, empty and unresolved recovery regressions',() => {
  const batch = {id:'b',txn_count:1,status:'draft',entry_date:'2026-11-30'};
  const run = (module,b,settings={bookkeeping_mode:'silo'},claims=[]) => module.reviewCount([b],settings,claims);
  const mutations = [
    ["      if (settings?.bookkeeping_mode === 'qbo') continue;",batch,{bookkeeping_mode:'qbo'},[]],
    ["      if (row.source_posting_start_on && ends && ends < row.source_posting_start_on) continue;",{...batch,source_posting_start_on:'2026-12-01'},undefined,[]],
    ["      if (!(number(row.txn_count) > 0)) continue;",{...batch,txn_count:0},undefined,[]],
    ["        if (claims.some(c => c.source_ref === row.id && ['submitting','unknown'].includes(c.status))) count += 1;",{...batch,status:'approved'},{bookkeeping_mode:'qbo'},[{source_ref:'b',status:'unknown'}]]
  ];
  for (const [guard,b,settings,claims] of mutations) {
    assert.ok(source.includes(guard));
    const mutant = api(source.replace(guard,'')).api;
    assert.notEqual(run(mutant,b,settings,claims),run(A,b,settings,claims));
  }
});
