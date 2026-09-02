'use strict';
const { loadV3 } = require('../lib/load');
const g = loadV3(['report-params.js', 'field-semantics.js', 'chart-adapter.js']);
const C = g.SiloChart, F = g.SiloFieldSemantics;
let fails=0;
const ok=(n,c)=>{ if(c) console.log('  ok  '+n); else {console.log('  FAIL '+n); fails++;} };

// 1. top products: string dim + numeric measures (net_sales arrives as string from numeric)
const top=[{product_name:'Bubbles and Doubles Tee',net_sales:'241033.55',units:19362},
           {product_name:'Stuck On The Game Shorts',net_sales:'118240.00',units:13219},
           {product_name:'Pin of the Month',net_sales:'4210.5',units:842}];
let p=C.profileColumns(top);
ok('product_name is string', p.find(c=>c.name==='product_name').type==='string');
ok('net_sales string-numeric detected as number', p.find(c=>c.name==='net_sales').type==='number');
let r=C.recommend(top);
ok('3 rows / 1 dim -> donut or bar', ['bar','donut'].includes(r.visual_type));
ok('recommend picks first measure', r.visual_config.y_field==='net_sales');

// 2. time series
const ts=Array.from({length:30},(_,i)=>({day_date:`2026-08-${String(i+1).padStart(2,'0')}`,net_sales:1000+i*13}));
ok('date column detected', C.profileColumns(ts).find(c=>c.name==='day_date').type==='date');
r=C.recommend(ts);
ok('date dim -> line', r.visual_type==='line');
ok('line sorts by x asc', r.visual_config.sort==='x_asc');

// 3. single row single measure -> kpi
r=C.recommend([{total_net_sales:918233.19}]);
ok('1x1 -> kpi', r.visual_type==='kpi' && r.visual_config.y_field==='total_net_sales');

// 4. shape: sort + limit
let s=C.shape(top,{x_field:'product_name',y_field:'units',sort:'desc',limit:2});
ok('shape limits to 2', s.points.length===2);
ok('shape sorts desc', s.points[0].value===19362);
ok('shape flags truncation', s.truncated===true && s.totalRows===3);
s=C.shape(top,{x_field:'product_name',y_field:'net_sales',sort:'asc',limit:0});
ok('asc sort, string measures compare numerically', s.points[0].value===4210.5);
ok('format inferred as currency from net_sales', s.format==='currency');

// 5. switching visual keeps fields: config from a table carried to a bar
s=C.shape(top,{x_field:'product_name',y_field:'units',sort:'none'});
ok('sort none keeps query order', s.points[0].label==='Bubbles and Doubles Tee');

// 6. bad/absent config falls back to first dim + first measure
s=C.shape(top,{x_field:'nonexistent_col',y_field:'also_missing'});
ok('unknown fields fall back', s.xField==='product_name' && s.yField==='net_sales');
ok('no dim/measure -> null', C.shape([{a:'x'},{a:'y'}],{})===null);
ok('empty rows -> null', C.shape([],{})===null);

// 7. formatting
ok('currency', C.formatValue(241033.55,'currency')==='$241,034'||C.formatValue(241033.55,'currency')==='$241,034');
ok('percent from fraction', C.formatValue(0.78,'percent')==='78%');
ok('percent already scaled', C.formatValue(78,'percent')==='78%');
ok('null stays empty', C.formatValue(null,'number')==='');
ok('non numeric passthrough', C.formatValue('n/a','number')==='n/a');

// 8. option generation
s=C.shape(top,{x_field:'product_name',y_field:'net_sales',sort:'desc',limit:10});
let opt=C.optionFor('bar',s);
ok('bar option has one series', opt.series.length===1);
ok('long labels -> horizontal bar (category on yAxis)', opt.yAxis.type==='category');
ok('bar values reversed for horizontal', opt.series[0].data[opt.series[0].data.length-1]===241033.55);
let lineOpt=C.optionFor('line',C.shape(ts,{x_field:'day_date',y_field:'net_sales',sort:'x_asc'}));
ok('line option is a line series', lineOpt.series[0].type==='line');
ok('line keeps category on x', lineOpt.xAxis.type==='category');
let d=C.optionFor('donut',C.shape(top,{x_field:'product_name',y_field:'units',sort:'desc'}));
ok('donut is a pie with 3 slices', d.series[0].type==='pie' && d.series[0].data.length===3);

// 9. html visuals
let html=C.tableHtml(top,{y_field:'units',sort:'desc',limit:2});
ok('table limited + note', html.includes('Showing 2 of 3 rows'));
ok('table right-aligns numbers', html.includes('class="dw-num"'));
ok('table escapes', C.tableHtml([{a:'<img src=x onerror=1>'}],{}).includes('&lt;img'));
ok('kpi sums by default', C.kpiHtml(top,{y_field:'units'}).includes('33,423'));
ok('kpi first for single row', C.kpiHtml([{total:5}],{y_field:'total'}).includes('$5.00'));
ok('total_units is a count, not currency', C.inferFormat('total_units')==='count');
ok('net_sales is currency', C.inferFormat('net_sales')==='currency');
ok('order_count is a count', C.inferFormat('order_count')==='count');
ok('pct_of_expected_units is percent', C.inferFormat('pct_of_expected_units')==='percent');
ok('kpi avg', C.kpiHtml([{v:10},{v:20}],{y_field:'v',aggregate:'avg'}).includes('15'));
ok('kpi with no numeric column says so', C.kpiHtml([{name:'x'}],{}).includes('No numeric column'));

// 10. nulls in the data
const withNulls=[{loc:'Retail',sales:100},{loc:null,sales:null},{loc:'Web',sales:50}];
s=C.shape(withNulls,{x_field:'loc',y_field:'sales',sort:'desc'});
ok('null measure sorts last', s.points[2].value===null);
ok('null label renders as dash in option', C.optionFor('bar',s).series[0].data.length===3);

// ── aggregation (grouping happens before sort+limit) ──
const dup=[{loc:'Retail',sales:100},{loc:'Retail',sales:50},{loc:'Web',sales:120}];
s=C.shape(dup,{x_field:'loc',y_field:'sales'});
ok('rows sharing a dimension are rolled up', s.points.length===2);
ok('sum is the default aggregate', s.points.find(p=>p.label==='Retail').value===150);
ok('grouping is reported for the footer', s.aggregatedFrom===3);
ok('sorted after grouping, not before', s.points[0].label==='Retail');
s=C.shape(dup,{x_field:'loc',y_field:'sales',aggregate:'none'});
ok("aggregate 'none' plots every row", s.points.length===3 && s.aggregatedFrom===0);
s=C.shape(dup,{x_field:'loc',y_field:'sales',aggregate:'avg'});
ok('avg aggregates correctly', s.points.find(p=>p.label==='Retail').value===75);
// group-then-limit is a different answer from limit-then-group
s=C.shape(dup,{x_field:'loc',y_field:'sales',limit:1});
ok('top-1 after grouping is Retail(150), not Web(120)', s.points[0].label==='Retail' && s.points[0].value===150);
// null and empty-string dimensions must not merge
const nulls=[{d:null,v:1},{d:'',v:2},{d:'x',v:3}];
ok('null and empty-string dimensions stay separate', C.shape(nulls,{x_field:'d',y_field:'v'}).points.length===3);
// a rate must not be summed by default
ok('percent defaults to avg, not sum', C.defaultAggregate('percent')==='avg');
ok('currency defaults to sum', C.defaultAggregate('currency')==='sum');

// ── semantics: the four layers ──
const catalog=F.buildCatalogIndex([{relname:'t',columns:[
  {name:'total_units',type:'bigint'},{name:'net_sales',type:'numeric'},
  {name:'day_date',type:'date'},{name:'conversion_rate',type:'numeric'}]}]);
const prof=C.profileColumns([{total_units:5,net_sales:1.5,conversion_rate:0.4,other:2}]);
const R=(n)=>F.resolve(n,(prof.find(c=>c.name===n)||{}).type||'number',{catalogIndex:catalog});
ok('catalog: an integer column is a count even when named like money', R('total_units').semantic==='count');
ok('catalog: grounded, not guessed', R('total_units').source==='catalog');
ok('catalog: numeric + money name is currency', R('net_sales').semantic==='currency');
ok('catalog: numeric + rate name is percent', R('conversion_rate').semantic==='percent');
ok('unknown column falls back to name heuristics', R('other').source==='inferred');
ok('report metadata beats the catalog',
   F.resolve('total_units','number',{catalogIndex:catalog,reportMetadata:{total_units:{semantic:'currency'}}}).semantic==='currency');
ok('a widget override beats the report',
   F.resolve('total_units','number',{catalogIndex:catalog,reportMetadata:{total_units:{semantic:'currency'}},overrides:{total_units:'percent'}}).semantic==='percent');
ok('a non-numeric value is a category whatever the catalog says',
   F.resolve('net_sales','string',{catalogIndex:catalog}).semantic==='category');
ok('an ambiguous name across the schema is dropped, not guessed',
   F.buildCatalogIndex([{relname:'a',columns:[{name:'total',type:'integer'}]},
                        {relname:'b',columns:[{name:'total',type:'numeric'}]}]).has('total')===false);
ok('only grounded answers are seeded back to the report',
   Object.keys(F.seedableMetadata({a:{semantic:'currency',source:'inferred'},
                                   b:{semantic:'count',source:'catalog'}})).join()==='b');
// ── formatting by semantic ──
ok('a count never prints decimals', C.formatValue(19362.5,'count')==='19,363');
ok('currency still prints as currency', C.formatValue(241033.55,'currency').startsWith('$241,034'));

// ── jsonb results (what Ask SILO's json_agg/row_to_json actually returns) ──
const jsonRows=[{ad_totals:{total_spend:301480.6},by_platform:[{platform:'meta_ads',spend:1}],shopify_online:{online_net_sales:9}}];
const jp=C.profileColumns(jsonRows);
ok('a jsonb object column is profiled as json', jp.find(c=>c.name==='ad_totals').type==='json');
ok('a jsonb array column is profiled as json', jp.find(c=>c.name==='by_platform').type==='json');
ok('json is not offered as a dimension', !C.dimensionsOf(jp).some(c=>c.type==='json'));
ok('json is not offered as a measure', !C.measuresOf(jp).some(c=>c.type==='json'));
const jh=C.tableHtml(jsonRows,{});
ok('table renders the JSON, not [object Object]', !jh.includes('[object Object]') && jh.includes('total_spend'), jh.slice(0,180));
ok('a jsonb result is recommended as a TABLE, never a chart', C.recommend(jsonRows).visual_type==='table');
const longJson=[{blob:{s:'x'.repeat(400)}}];
ok('a huge JSON cell is truncated with the full value in a tooltip',
   C.tableHtml(longJson,{}).includes('…') && C.tableHtml(longJson,{}).includes('title="'));

// ── multi-measure: the ROAS acceptance test ──
// Real shape from Ask SILO: one row per day, sales + spend + roas.
const roas=Array.from({length:30},(_,i)=>({
  day_date:`2026-08-${String(i+1).padStart(2,'0')}`,
  online_net_sales: 25000+i*400, ad_spend: 9000+i*90, roas: +(2.5+i*0.03).toFixed(2)}));
const roasSem={day_date:'date',online_net_sales:'currency',ad_spend:'currency',roas:'number'};
let m=C.shape(roas,{x_field:'day_date',measures:['online_net_sales','ad_spend','roas'],sort:'x_asc'},roasSem);
ok('three measures become three series', m.series.length===3);
ok('sales and spend share the LEFT axis', m.series[0].axis===0 && m.series[1].axis===0);
ok('roas is pushed to the SECOND axis', m.series[2].axis===1, JSON.stringify(m.series.map(s=>[s.field,s.axis])));
ok('shape flags that a second axis is needed', m.hasSecondAxis===true);
ok('each series keeps its own semantic', m.series[0].semantic==='currency' && m.series[2].semantic==='number');
ok('points carry every measure', Object.keys(m.points[0].values).join()==='online_net_sales,ad_spend,roas');

let o=C.optionFor('line',m);
ok('option has three series', o.series.length===3);
ok('two value axes are emitted', Array.isArray(o.yAxis) && o.yAxis.length===2);
ok('the second axis sits on the right', o.yAxis[1].position==='right');
ok('a legend appears only when multi-series', !!o.legend);
ok('axis labels format per-axis semantic: left is currency',
   o.yAxis[0].axisLabel.formatter(30000).startsWith('$'));
ok('...and the right axis is not', !o.yAxis[1].axisLabel.formatter(3).startsWith('$'));

// combo: in a BAR chart the secondary measure is drawn as a line
let ob=C.optionFor('bar',m);
ok('bar chart: primary measures stay bars', ob.series[0].type==='bar' && ob.series[1].type==='bar');
ok('bar chart: the secondary-axis measure becomes a line', ob.series[2].type==='line');

// a ratio must NOT be summed when grouped alongside currency
const dupMix=[{d:'a',sales:100,rate:0.4},{d:'a',sales:100,rate:0.6}];
let gMix=C.shape(dupMix,{x_field:'d',measures:['sales','rate']},{sales:'currency',rate:'percent'});
ok('currency is summed', gMix.points[0].values.sales===200);
ok('a percent is AVERAGED, not summed', Math.abs(gMix.points[0].values.rate-0.5)<1e-9,
   String(gMix.points[0].values.rate));

// two measures of the same semantic and similar scale stay on one axis
let same=C.shape(roas,{x_field:'day_date',measures:['online_net_sales','ad_spend'],sort:'x_asc'},roasSem);
ok('similar measures share one axis', same.hasSecondAxis===false);
ok('and only one value axis is emitted', !Array.isArray(C.optionFor('line',same).yAxis) || C.optionFor('line',same).yAxis.length===1);

// backwards compatibility: every widget built before this used y_field
let old=C.shape(roas,{x_field:'day_date',y_field:'ad_spend',sort:'x_asc'},roasSem);
ok('single y_field still works', old.series.length===1 && old.yField==='ad_spend');
ok('...and .value still points at it', old.points[0].value===old.points[0].values.ad_spend);
ok('...with no legend and one axis', !C.optionFor('line',old).legend);

// ── donut: a truncated part-of-whole chart must still be a whole ──
const locs=Array.from({length:12},(_,i)=>({loc:'L'+i,net_sales:(12-i)*1000}));
const dsh=C.shape(locs,{x_field:'loc',y_field:'net_sales',sort:'desc',limit:10},{net_sales:'currency'});
ok('truncation records what was dropped', dsh.droppedCount===2);
const dopt=C.optionFor('donut',dsh);
ok('donut adds an Other slice', dopt.series[0].data.length===11);
ok('...labelled with how many it covers', /Other \(2\)/.test(dopt.series[0].data[10].name));
const totalPlotted=dopt.series[0].data.reduce((a,d)=>a+d.value,0);
const trueTotal=locs.reduce((a,r)=>a+r.net_sales,0);
ok('...so the slices sum to the real total (percentages are honest)', totalPlotted===trueTotal,
   `${totalPlotted} vs ${trueTotal}`);
const barOpt=C.optionFor('bar',dsh);
ok('a BAR chart still just shows its top N, no Other', barOpt.series[0].data.length===10);
const untrunc=C.shape(locs,{x_field:'loc',y_field:'net_sales',limit:0},{net_sales:'currency'});
ok('an untruncated donut gets no Other slice', C.optionFor('donut',untrunc).series[0].data.length===12);

console.log(fails? `\n${fails} FAILURES`:'\nall passed');
process.exit(fails?1:0);
