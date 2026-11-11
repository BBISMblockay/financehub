// The "Generate AI summary" card on the Attribution page, rendered for real
// against synthetic data. Nothing leaves the browser: the edge function is a
// stubbed fetch, and what the page WOULD have sent is asserted from the body it
// built.
const {chromium}=require('playwright');
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'../../..');
 const {allocate}=await import('../../../v2/silo-attribution-model.js');
 const company='3bd934c9-4cdd-429b-9076-f8f6b45d4eb7',store='00000000-0000-0000-0000-000000000002';
 const stamp='2026-10-09T10:00:00Z',rows=[],records=[];
 for(let n=1;n<=8;n++){
  const visits=[['facebook','paid',1],['redo','sms',3],['google','cpc',4]].map(([source,medium,day],i)=>({id:`${n}-${i}`,occurredAt:`2026-09-0${day}T12:00:00Z`,utmParameters:{source,medium}}));
  const order={id:'gid://shopify/Order/'+n,name:'#SYNTHETIC-'+n,sourceName:'web',createdAt:'2026-09-05T12:00:00Z',customerJourneySummary:n===8?{ready:false}:{ready:true,firstVisit:visits[0],lastVisit:visits[2],moments:{nodes:visits,pageInfo:{hasNextPage:false}}}};
  const allocation=allocate(order,null,null,{windowDays:30});
  const row={company_entity_id:company,connection_id:store,order_id:String(n),order_name:order.name,window_days:30,allocation,channel:allocation.channel,net_cents:n===7?-5000:12501,total_cents:n===7?-5500:13503,evidence_fetched_at:stamp,extracted_at:stamp,day:'2026-09-30'};
  rows.push(row);records.push({...row,fetched_at:stamp,evidence:{order,own_hosts:[]}});
 }
 const controls=[{day:'2026-09-30',currency:'USD',shop_timezone:'UTC',net_cents:rows.reduce((s,r)=>s+r.net_cents,0),total_cents:rows.reduce((s,r)=>s+r.total_cents,0),extracted_at:stamp}];
 const server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.SILO_CHROMIUM?{executablePath:process.env.SILO_CHROMIUM}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:')?route.continue():route.abort());
  await page.route('**/pages/config.js',r=>r.fulfill({contentType:'text/javascript',body:`window.__SILO_CONFIG__={SUPABASE_URL:'synthetic',SUPABASE_ANON_KEY:'synthetic',ensureActiveCompany:async()=>({id:'${company}',entity_key:'baseballism'})};`}));
  await page.route('**/lib/supabase-js.min.js',r=>r.fulfill({contentType:'text/javascript',body:`
   window.fixture=${JSON.stringify({rows,records,controls,company,store})};
   window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:window.noToken?null:'synthetic-token',user:{id:'synthetic-user',email:'fixture@example.test'}}}})},rpc:async(name,args)=>({data:name==='nav_badge_counts'?{}:name==='ai_credit_summary'?window.creditSummary||null:name==='is_admin_user'?!window.nonAdmin
    // Both report reads go through the reporting engine: the ledger rows, and the journeys
    // projected to the fields the rollup classifies.
    :/shopify_attribution_orders/.test(args&&args.query||'')?fixture.records.map(r=>({company_entity_id:r.company_entity_id,connection_id:r.connection_id,order_id:r.order_id,order_evidence:r.evidence.order,own_hosts:r.evidence.own_hosts,fetched_at:window.staleFixture?'changed':r.fetched_at}))
    :window.emptyFixture?[]:fixture.rows}),from(table){const filters={};let mode='select',payload;
    const q={select(){return q;},range(){return q;},eq(k,v){filters[k]=v;return q;},gte(){return q;},lte(){return q;},in(k,v){filters[k]=v;return q;},order(){return q;},limit(){return q;},single(){return q;},maybeSingle(){return q;},insert(p){mode='insert';payload=p;return q;},then(resolve){
     if(mode==='insert')return resolve({error:{message:'unexpected write'}});
     let data=[];if(table==='profiles')data=typeof filters.id==='string'?{role:'admin',active_company_id:fixture.company}:[{id:'synthetic-user',name:'Synthetic reviewer'}];
     if(table==='entity_memberships')data=filters.user_id?{user_id:'synthetic-user'}:[{user_id:'synthetic-user'}];
     if(table==='shopify_connections')data=[{id:fixture.store,shop_domain:'synthetic.example.test'}];
     // Deferred answers: the edge function commits a long answer here and the
     // page collects it by request id (RLS scopes the table to the asker).
     if(table==='silo_chat_responses')data=window.deferredResponse&&filters.request_id===window.deferredResponse.request_id?window.deferredResponse:null;
     if(table==='shopify_attribution_days')data=window.emptyFixture?fixture.controls.map(c=>({...c,net_cents:0,total_cents:0})):fixture.controls;
     // Only the drilldown reads a row of this table now, and it reads one order's whole evidence.
     if(table==='shopify_attribution_orders')data=fixture.records.find(r=>r.order_id===filters.order_id)||null;
     if(window.spendFail&&table==='marketing_kpis_daily')return resolve({data:null,error:{message:'spend read refused'}});
     if(table==='marketing_kpis_daily')data=[{platform:'meta_ads',day_date:'2026-09-30',spend:300},{platform:'google_ads',day_date:'2026-09-30',spend:50}];
     if(table==='redo_marketing_daily')data=[{channel:'SMS',day_date:'2026-09-30',spend:12.5,spend_currency:'USD'}];
     // Completed sync windows; partialSpend leaves the ad platforms without one.
     // Completed sync windows, and the "has this ever run" probe, both read
     // this table; the probe asks per job_type, so the stub has to honour that
     // filter. Without it every spend source looks connected in this fixture,
     // including one this synthetic company does not use, and the total reads
     // as incomplete for a reason that does not exist.
     if(table==='sync_jobs')data=['meta_ads_kpis','google_ads_kpis','tiktok_ads_kpis','redo_marketing'].filter(j=>!window.partialSpend||j==='redo_marketing').filter(j=>!filters.job_type||(Array.isArray(filters.job_type)?filters.job_type.includes(j):j===filters.job_type)).map(job_type=>({job_type,window:{startDate:'2026-09-01',endDate:'2026-10-01'}}));
     resolve({data,count:Array.isArray(data)?data.length:null});}};return q;}})};` }));
  // The page loads marked + DOMPurify from a CDN, which this test refuses to
  // reach. Stand-ins, so the rendering PATH is exercised (the libraries
  // themselves are not ours to test); `window.noMarkdown` removes them to
  // prove the plain-text fallback.
  await page.route(/marked\.min\.js/,r=>r.fulfill({contentType:'text/javascript',body:"if(!window.noMarkdown)window.marked={parse:function(t){return '<p>'+String(t).split('**').map(function(p,i){return i%2?'<strong>'+p+'</strong>':p;}).join('')+'</p>';}};"}));
  await page.route(/purify\.min\.js/,r=>r.fulfill({contentType:'text/javascript',body:"if(!window.noMarkdown)window.DOMPurify={sanitize:function(html){return String(html);}};"}));

  // The edge function, stubbed. `window.aiStub` decides what comes back, and
  // every request body is kept so the prompt can be asserted.
  await page.addInitScript(()=>{
   window.aiCalls=[];
   window.aiStub={status:200,body:{answer:'Paid traffic carried the period.\n\n- **Meta Ads** started 7 of 8 orders.\n- Google Ads closed most of them.',ai_credit:{status:'charged',charged_micros:4200}}};
   const real=window.fetch.bind(window);
   window.fetch=(input,init)=>{
    const url=String(input&&input.url||input||'');
    if(!/\/functions\/v1\/silo-chat$/.test(url))return real(input,init);
    const body=JSON.parse(init.body);window.aiCalls.push(body);
    if(window.aiStub.deferred){window.deferredResponse={request_id:body.request_id,http_status:200,response:window.aiStub.body};
     return Promise.resolve(new Response(JSON.stringify({pending:true}),{status:202,headers:{'Content-Type':'application/json'}}));}
    return Promise.resolve(new Response(JSON.stringify(window.aiStub.body),{status:window.aiStub.status,headers:{'Content-Type':'application/json'}}));
   };
  });
  const url=`http://127.0.0.1:${server.address().port}/v2/silo-attribution.html?start=2026-09-30&end=2026-09-30`;
  await page.goto(url);await page.waitForSelector('#aisummary .attr-ai',{timeout:10000}).catch(async e=>{console.error(await page.locator('body').innerText(),errors);throw e;});

  // The card sits with the report's own figures, says what it does, and costs
  // nothing until it is asked.
  const card=page.locator('#aisummary .attr-ai');
  assert.match(await card.innerText(),/AI summary[\s\S]*Generate AI summary/);
  assert.match(await card.innerText(),/reads only the figures already on this page/);
  assert.equal(await page.locator('#ai-generate').isEnabled(),true);
  assert.deepEqual(await page.evaluate(()=>window.aiCalls),[]);

  // Generate: one request, carrying this period's reconciled figures, and the
  // answer is rendered as markdown.
  await page.locator('#ai-generate').click();
  const calls=await page.evaluate(()=>window.aiCalls);
  assert.equal(calls.length,1);
  assert.equal(calls[0].company_entity_id,company);
  assert.equal(calls[0].history.length,1);
  const sent=calls[0].history[0].content;
  for(const needle of ['2026-09-30 through 2026-09-30','Net sales: $825','Orders: 8','Marketing spend: $363 (complete','Meta Ads:','Google Ads:','Do not run any SQL','not proof a channel caused a sale'])
   assert.ok(sent.includes(needle),'prompt carries '+needle);
  assert.match(await page.locator('.attr-ai-answer').innerText(),/Paid traffic carried the period/);
  assert.equal(await page.locator('.attr-ai-answer strong',{hasText:'Meta Ads'}).count(),1,'markdown rendered, not escaped');
  assert.match(await page.locator('#ai-note').innerText(),/figures on this page only/);
  // No AI credit summary for this viewer, so no price tag is shown.
  assert.doesNotMatch(await page.locator('#ai-note').innerText(),/credit/i);
  // The report it summarizes is untouched.
  assert.ok(await page.locator('.attr-scorecard').isVisible());

  // Without those libraries the answer is still delivered, as escaped text.
  await page.evaluate(()=>{window.marked=undefined;window.DOMPurify=undefined;window.aiStub.body.answer='Plain **text** fallback <b>not markup</b>.';});
  await page.locator('#ai-generate').click();await page.waitForFunction(()=>/fallback/.test(document.querySelector('#ai-body').textContent));
  assert.equal(await page.locator('.attr-ai-answer b').count(),0,'answer text is never treated as markup');
  assert.match(await page.locator('.attr-ai-answer').innerText(),/Plain \*\*text\*\* fallback <b>not markup<\/b>\./);
  await page.reload();await page.waitForSelector('#aisummary .attr-ai');await page.waitForSelector('.attr-scorecard');

  // The person who pays sees what the answer cost, from the same helper
  // Ask SILO uses. Everyone else does not.
  await page.evaluate(()=>{window.creditSummary={state:'active',can_top_up:true,available_micros:50000000,plan_included_micros:50000000};});
  await page.locator('#ai-generate').click();await page.waitForSelector('.attr-ai-answer');
  await page.waitForFunction(()=>/AI credit/.test(document.querySelector('#ai-note').textContent));
  assert.match(await page.locator('#ai-note').innerText(),/\$0\.01 AI credit|<\$0\.01 AI credit/);

  // A refusal stays inside the card: the report, the tables and the button all
  // survive it, and asking again works.
  await page.evaluate(()=>{window.aiStub={status:402,body:{error:'AI credit for this workspace is used up.'}};});
  await page.locator('#ai-generate').click();
  await page.waitForSelector('#aisummary .bcn-status--neg');
  assert.match(await page.locator('#aisummary .bcn-status--neg').innerText(),/AI credit for this workspace is used up/);
  assert.ok(await page.locator('.attr-scorecard').isVisible(),'a failed summary never takes the report down');
  assert.equal(await page.locator('#ai-generate').isEnabled(),true);

  // A long answer: 202 now, collected by request id from silo_chat_responses.
  await page.evaluate(()=>{window.aiStub={deferred:true,body:{answer:'Collected later.',ai_credit:{status:'free'}}};});
  await page.locator('#ai-generate').click();
  await page.waitForSelector('.attr-ai-answer',{timeout:15000});
  assert.match(await page.locator('.attr-ai-answer').innerText(),/Collected later/);

  // Changing a filter drops the answer rather than leaving it under numbers it
  // was not written about.
  await page.locator('#start').fill('2026-09-29');await page.locator('#start').dispatchEvent('change');
  assert.equal(await page.locator('.attr-ai-answer').count(),0);
  assert.equal(await page.locator('#aisummary .attr-ai').count(),1,'the card stays, empty');
  await page.locator('#start').fill('2026-09-30');await page.locator('#load').click();await page.waitForSelector('.attr-scorecard');

  // A period with no orders is not summarized at all.
  await page.evaluate(()=>{window.emptyFixture=true;});
  await page.locator('#load').click();await page.waitForSelector('.attr-together');
  assert.match(await page.locator('#ai-body').innerText(),/nothing to summarize/);
  assert.equal(await page.locator('#ai-generate').isDisabled(),true);
  const before=(await page.evaluate(()=>window.aiCalls)).length;
  await page.locator('#ai-generate').click({force:true});
  assert.equal((await page.evaluate(()=>window.aiCalls)).length,before,'a disabled button never spends credit');

  assert.deepEqual(errors,[]);
  console.log('Attribution AI summary: card, prompt figures, markdown answer, credit note, refusal, deferred answer, filter change and empty period passed');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
