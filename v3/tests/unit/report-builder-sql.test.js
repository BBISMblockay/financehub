'use strict';
const { loadV3, PURE_MODULES } = require('../lib/load');
const g = loadV3(PURE_MODULES);
const R = g.SiloReportBuilder;
let fails=0,n=0;
const ok=(name,cond,extra)=>{n++;if(cond)console.log('  ok   '+name);else{console.log('  FAIL '+name+(extra?'\n        '+extra:''));fails++;}};

const view={relname:'sales_by_product_title_daily_v',relkind:'view',columns:[
 {name:'product_title',type:'text'},{name:'location_tag',type:'text'},{name:'day_date',type:'date'},
 {name:'units_sold',type:'bigint'},{name:'net_sales',type:'numeric'},{name:'company_entity_id',type:'uuid'}]};
const mv={relname:'sales_velocity_by_sku_location_mv',relkind:'matview',columns:[
 {name:'sku',type:'text'},{name:'company_entity_id',type:'uuid'},{name:'units_30d',type:'integer'}]};
const mvNoCo={relname:'weird_mv',relkind:'matview',columns:[{name:'x',type:'text'}]};

let s=R.buildSql(view,{columns:['product_title','net_sales'],limit:25,sortColumn:'net_sales',sortDir:'desc'});
ok('plain select quotes identifiers', s.includes('"product_title"')&&s.includes('"net_sales"'),s);
ok('order by + limit', /order by "net_sales" desc nulls last/.test(s)&&/limit 25/.test(s),s);
ok('no stray where when unfiltered', !/ where /.test(s),s);

s=R.buildSql(view,{summarise:true,dimensions:['product_title'],measures:[{column:'units_sold',agg:'sum',alias:'units'}],
  dateColumn:'day_date',dateRange:'30',sortColumn:'units',sortDir:'desc',limit:10});
ok('summarise builds group by', /group by 1/.test(s),s);
ok('aggregate aliased', /sum\("units_sold"\) as "units"/.test(s),s);
ok('date range becomes a predicate', /"day_date" >= current_date - 30/.test(s),s);
ok('sort by an aggregate ALIAS is allowed', /order by "units" desc/.test(s),s);

ok('summarise with no measures is refused (null)',
   R.buildSql(view,{summarise:true,dimensions:['product_title'],measures:[]})===null);

// filters
const f=(flt)=>R.buildSql(view,{columns:['net_sales'],filters:[flt]});
ok('text equals is quoted', /"location_tag" = 'online'/.test(f({column:'location_tag',op:'eq',value:'online'})));
ok('numeric compare is NOT quoted', /"net_sales" > 100/.test(f({column:'net_sales',op:'gt',value:'100'})));
ok('numeric column with non-numeric value falls back to a quoted literal',
   /"net_sales" > 'abc'/.test(f({column:'net_sales',op:'gt',value:'abc'})));
ok('contains wraps and quotes', /"location_tag" ilike '%shop%'/.test(f({column:'location_tag',op:'contains',value:'shop'})));
ok('is not empty needs no value', /"location_tag" is not null/.test(f({column:'location_tag',op:'notnull'})));
ok('empty value is dropped, not turned into = \'\'',
   !/ where /.test(f({column:'location_tag',op:'eq',value:''})));

// injection / unknown identifiers
ok('a column not in the catalog is ignored, not emitted',
   !/dropme/.test(R.buildSql(view,{columns:['product_title','dropme']})));
ok('an unknown filter column is ignored',
   !/ where /.test(f({column:'evil; drop table x',op:'eq',value:'1'})));
const quoteVal=f({column:'location_tag',op:'eq',value:"o'brien's"});
ok('single quotes in a value are doubled', /'o''brien''s'/.test(quoteVal),quoteVal);
ok('no semicolon can reach the SQL', !/;/.test(quoteVal),quoteVal);
const weird={relname:'t',relkind:'view',columns:[{name:'a"b',type:'text'}]};
ok('a double quote in a real column name is escaped',
   /"a""b"/.test(R.buildSql(weird,{columns:['a"b']})));

// matview scoping — the whole point
s=R.buildSql(mv,{columns:['sku','units_30d']});
ok('MATVIEW gets a forced company predicate', /"company_entity_id" = active_company_id\(\)/.test(s),s);
s=R.buildSql(view,{columns:['product_title']});
ok('a normal view does NOT (RLS already does it)', !/active_company_id/.test(s),s);
s=R.buildSql(mvNoCo,{columns:['x']});
ok('a matview without the column gets no bogus predicate', !/active_company_id/.test(s),s);

ok('limit is capped at 1000', /limit 1000/.test(R.buildSql(view,{columns:['net_sales'],limit:99999})));
ok('limit 0 means no limit clause', !/limit/.test(R.buildSql(view,{columns:['net_sales'],limit:0})));

// raw-SQL warning
const cat=[{relname:'sales_velocity_by_sku_location_mv',relkind:'matview'},{relname:'sales_by_day',relkind:'table'}];
ok('raw SQL over a matview warns',
   /every company's rows/i.test(R.checkRawSqlScope('select * from sales_velocity_by_sku_location_mv',cat)||''));
ok('...unless it already scopes itself',
   R.checkRawSqlScope('select * from sales_velocity_by_sku_location_mv where company_entity_id = active_company_id()',cat)===null);
ok('a normal table does not warn', R.checkRawSqlScope('select * from sales_by_day',cat)===null);

// semantics from catalog types
const md=R.metadataFromCatalog(view,'',[{net_sales:1,units_sold:2,day_date:'2026-01-01',product_title:'x'}]);
ok('net_sales -> currency', md.net_sales.semantic==='currency',JSON.stringify(md));
ok('units_sold -> count (bigint beats the name)', md.units_sold.semantic==='count');
ok('day_date -> date', md.day_date.semantic==='date');
ok('product_title -> category', md.product_title.semantic==='category');
ok('metadata is marked as catalog-grounded', md.net_sales.source==='catalog');

// ── plumbing columns ──
const cols=[{name:'id',type:'bigint'},{name:'company_entity_id',type:'uuid'},
 {name:'connection_id',type:'uuid'},{name:'row_hash',type:'text'},{name:'synced_at',type:'timestamp with time zone'},
 {name:'factory_id',type:'uuid'},{name:'account_id',type:'text'},{name:'media_id',type:'text'},
 {name:'day_date',type:'date'},{name:'spend',type:'numeric'},{name:'sku',type:'text'}];
const biz=R.businessColumns(cols).map(c=>c.name);
ok('surrogate key hidden', !biz.includes('id'));
ok('tenant id hidden', !biz.includes('company_entity_id'));
ok('sync bookkeeping hidden', !biz.includes('row_hash') && !biz.includes('synced_at'));
ok('a uuid join key is hidden', !biz.includes('factory_id'));
ok('a TEXT id is kept (account_id means which ad account)', biz.includes('account_id'));
ok('...and media_id is kept', biz.includes('media_id'));
ok('real data survives', biz.join()==='account_id,media_id,day_date,spend,sku', biz.join());

console.log(fails?`\n${fails} of ${n} FAILED`:`\nall ${n} passed`);
process.exit(fails?1:0);
