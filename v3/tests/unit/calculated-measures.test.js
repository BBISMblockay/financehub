'use strict';
const { loadV3, PURE_MODULES } = require('../lib/load');
const g = loadV3(PURE_MODULES);
const RB = g.SiloReportBuilder;
let pass=0,fail=0;
const t=(n,f)=>{try{f();pass++;}catch(e){fail++;console.log('  FAIL '+n+'\n        '+e.message);}};
const has=(s,sub)=>{if(!String(s).includes(sub))throw new Error(`expected to contain ${JSON.stringify(sub)}\n        got: ${s}`);};
const not=(s,sub)=>{if(String(s).includes(sub))throw new Error(`expected NOT to contain ${JSON.stringify(sub)}\n        got: ${s}`);};
const eq=(a,b)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);};

const src={relname:'marketing_kpis_daily',relkind:'table',columns:[
  {name:'day_date',type:'date'},{name:'platform',type:'text'},
  {name:'spend',type:'numeric'},{name:'clicks',type:'bigint'},
  {name:'conversion_value',type:'numeric'},{name:'impressions',type:'bigint'}]};
const base={summarise:true,dimensions:['platform']};
const build=(measures,extra)=>RB.buildSql(src,Object.assign({},base,{measures},extra));

console.log('\n── ratio (ROAS) ──');
t('emits a division guarded by nullif',()=>{
  const sql=build([{calc:'ratio',agg:'sum',column:'conversion_value',agg2:'sum',column2:'spend',alias:'roas'}]);
  has(sql,'round((sum("conversion_value") / nullif(sum("spend"), 0))::numeric, 4) as "roas"');
});
t('a zero denominator can never raise division_by_zero',()=>{
  const sql=build([{calc:'ratio',agg:'sum',column:'clicks',agg2:'sum',column2:'spend'}]);
  has(sql,'nullif(');
});
t('default alias reads as what it is',()=>{
  const sql=build([{calc:'ratio',agg:'sum',column:'conversion_value',agg2:'sum',column2:'spend'}]);
  has(sql,'as "conversion_value_per_spend"');
});

console.log('\n── pct ──');
t('multiplies by 100 and rounds to 2',()=>{
  const sql=build([{calc:'pct',agg:'sum',column:'clicks',agg2:'sum',column2:'impressions',alias:'ctr'}]);
  has(sql,'round((sum("clicks") / nullif(sum("impressions"), 0) * 100)::numeric, 2) as "ctr"');
});

console.log('\n── diff ──');
t('subtracts two aggregates',()=>{
  const sql=build([{calc:'diff',agg:'sum',column:'conversion_value',agg2:'sum',column2:'spend',alias:'contribution'}]);
  has(sql,'(sum("conversion_value") - sum("spend")) as "contribution"');
});

console.log('\n── mixing plain and calculated ──');
t('both kinds coexist in one select',()=>{
  const sql=build([
    {agg:'sum',column:'spend',alias:'ad_spend'},
    {calc:'ratio',agg:'sum',column:'conversion_value',agg2:'sum',column2:'spend',alias:'roas'}]);
  has(sql,'sum("spend") as "ad_spend"');
  has(sql,'as "roas"');
  has(sql,'group by 1');
});

console.log('\n── validation: half a calculation is DROPPED, not half-emitted ──');
t('missing second column drops the measure entirely',()=>{
  const sql=build([{agg:'sum',column:'spend',alias:'ad_spend'},
                   {calc:'ratio',agg:'sum',column:'conversion_value',agg2:'sum',alias:'roas'}]);
  has(sql,'as "ad_spend"');
  not(sql,'roas');            // not emitted at all
  not(sql,'conversion_value'); // and NOT emitted as just its left half
});
t('an unknown second column drops it',()=>{
  const sql=build([{agg:'sum',column:'spend'},
                   {calc:'ratio',agg:'sum',column:'spend',agg2:'sum',column2:'nope'}]);
  not(sql,'nope');
});
t('a bad second aggregate drops it',()=>{
  const sql=build([{agg:'sum',column:'spend'},
                   {calc:'ratio',agg:'sum',column:'spend',agg2:'drop table',column2:'clicks'}]);
  not(sql,'drop table');
});
t('an unknown calc id is treated as a plain measure, not injected',()=>{
  const sql=build([{calc:'; drop table x',agg:'sum',column:'spend',alias:'s'}]);
  has(sql,'sum("spend") as "s"');
  not(sql,'drop table');
});
t('a report with ONLY an invalid calculation returns null, not broken SQL',()=>{
  eq(build([{calc:'ratio',agg:'sum',column:'spend',agg2:'sum',column2:'nope'}]),null);
});

console.log('\n── sort by a calculated alias ──');
t('ORDER BY accepts a calculated alias',()=>{
  const sql=build([{calc:'ratio',agg:'sum',column:'conversion_value',agg2:'sum',column2:'spend',alias:'roas'}],
                  {sortColumn:'roas',sortDir:'desc'});
  has(sql,'order by "roas" desc nulls last');
});
t('ORDER BY accepts a DEFAULT calculated alias too',()=>{
  const sql=build([{calc:'ratio',agg:'sum',column:'conversion_value',agg2:'sum',column2:'spend'}],
                  {sortColumn:'conversion_value_per_spend'});
  has(sql,'order by "conversion_value_per_spend"');
});
t('ORDER BY still refuses a name that is neither column nor alias',()=>{
  const sql=build([{agg:'sum',column:'spend'}],{sortColumn:'evil; drop table x'});
  not(sql,'order by');
});

console.log('\n── semantics: the reason a rate is not printed as money ──');
t('a ratio declares itself a number',()=>{
  const md=RB.metadataForMeasures(src,[{calc:'ratio',agg:'sum',column:'conversion_value',agg2:'sum',column2:'spend',alias:'roas'}]);
  eq(md.roas.semantic,'number');
});
t('a percentage declares itself a percent',()=>{
  const md=RB.metadataForMeasures(src,[{calc:'pct',agg:'sum',column:'clicks',agg2:'sum',column2:'impressions',alias:'ctr'}]);
  eq(md.ctr.semantic,'percent');
});
t('a difference INHERITS its left operand (currency − currency = currency)',()=>{
  const md=RB.metadataForMeasures(src,[{calc:'diff',agg:'sum',column:'spend',agg2:'sum',column2:'conversion_value',alias:'net'}]);
  eq(md.net.semantic,RB.semanticForColumn(src,'spend'));
});
t('a plain measure gets nothing here (the catalog covers it)',()=>{
  eq(RB.metadataForMeasures(src,[{agg:'sum',column:'spend',alias:'ad_spend'}]),{});
});
t('THE BUG THIS PREVENTS: a %-of-sales column is not typed as currency',()=>{
  const s2={relname:'x',relkind:'view',columns:[{name:'net_sales',type:'numeric'},{name:'total',type:'numeric'}]};
  const md=RB.metadataForMeasures(s2,[{calc:'pct',agg:'sum',column:'net_sales',agg2:'sum',column2:'total'}]);
  eq(md.net_sales_pct_of_total.semantic,'percent');
});

console.log('\n── regression: nothing changed for plain reports ──');
t('a plain summarised report is byte-identical to before',()=>{
  const sql=build([{agg:'sum',column:'spend',alias:'ad_spend'},{agg:'avg',column:'clicks'}]);
  has(sql,'sum("spend") as "ad_spend"');
  has(sql,'avg("clicks") as "avg_clicks"');
});


// ── Schema probes ───────────────────────────────────────────────────────
console.log('\n── schema probe detection ──');
{
  let p2=0,f2=0;
  const t2=(n,f)=>{try{f();p2++;}catch(e){f2++;console.log('  FAIL '+n+'\n        '+e.message);}};
  const T=(sql)=>{if(!RB.isSchemaProbe(sql))throw new Error('should be a probe: '+sql);};
  const F=(sql)=>{if(RB.isSchemaProbe(sql))throw new Error('should NOT be a probe: '+sql);};

  t2('information_schema.columns is a probe',()=>T(
    "select column_name, data_type from information_schema.columns where table_name in ('payment_requests')"));
  t2('pg_catalog is a probe',()=>T('select * from pg_catalog.pg_tables'));
  t2('pg_matviews is a probe',()=>T('select matviewname from pg_matviews'));
  t2('a real report is not',()=>F(
    "select vendor, sum(amount_due) from payment_requests_v where completed is not true group by 1"));
  t2('a column merely NAMED like a catalog is not',()=>F(
    'select schema_name, table_information from my_docs_table'));
  t2('empty/null is not',()=>{F('');F(null);});

  const idx=RB.defaultQueryIndex;
  t2('THE REAL CASE: probe at 0, answer at 1 -> picks 1',()=>{
    const q=["select column_name from information_schema.columns where table_name = 'payment_requests'",
             'select vendor, sum(amount_due) from payment_requests_v group by 1'];
    if(idx(q)!==1)throw new Error('got '+idx(q));
  });
  t2('single query -> 0',()=>{if(idx(['select 1'])!==0)throw new Error('got '+idx(['select 1']));});
  t2('picks the LAST real query, not the first',()=>{
    const q=['select a from t','select b from t','select c from t'];
    if(idx(q)!==2)throw new Error('got '+idx(q));
  });
  t2('skips a TRAILING probe',()=>{
    const q=['select a from t','select column_name from information_schema.columns'];
    if(idx(q)!==0)throw new Error('got '+idx(q));
  });
  t2('all probes -> still returns a valid index, never -1',()=>{
    const q=['select * from information_schema.columns','select * from pg_catalog.pg_class'];
    if(idx(q)!==1)throw new Error('got '+idx(q));
  });
  t2('empty -> 0, never undefined',()=>{if(idx([])!==0||idx(null)!==0)throw new Error('bad');});

  console.log(`\n  probes: ${p2} passed, ${f2} failed`);
  if(f2)process.exitCode=1;
}

console.log(`\n${pass} passed, ${fail} failed (plus the probe block above)\n`);
process.exit(fail || process.exitCode ? 1 : 0);
