// Real page/module rendering against explicitly synthetic data; no external requests.
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
   window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{user:{id:'synthetic-user',email:'fixture@example.test'}}}})},rpc:async(name)=>({data:name==='nav_badge_counts'?{}:window.emptyFixture?[]:fixture.rows}),from(table){const filters={};let mode='select',payload;
    const q={select(){return q;},range(){return q;},eq(k,v){filters[k]=v;return q;},gte(){return q;},lte(){return q;},in(k,v){filters[k]=v;return q;},order(){return q;},limit(){return q;},single(){return q;},maybeSingle(){return q;},insert(p){mode='insert';payload=p;return q;},then(resolve){
     if(mode==='insert')return resolve({error:{message:'unexpected write'}});
     let data=[];if(table==='profiles')data=typeof filters.id==='string'?{role:'admin',active_company_id:fixture.company}:[{id:'synthetic-user',name:'Synthetic reviewer'}];
     if(table==='entity_memberships')data=filters.user_id?{user_id:'synthetic-user'}:[{user_id:'synthetic-user'}];
     if(table==='shopify_connections')data=[{id:fixture.store,shop_domain:'synthetic.example.test'}];
     if(table==='shopify_attribution_days')data=window.emptyFixture?fixture.controls.map(c=>({...c,net_cents:0,total_cents:0})):fixture.controls;
     if(table==='shopify_attribution_orders')data=typeof filters.order_id==='string'?fixture.records.find(r=>r.order_id===filters.order_id):window.staleFixture?fixture.records.map(r=>({...r,fetched_at:'changed'})):fixture.records;
     if(window.spendFail&&table==='marketing_kpis_daily')return resolve({data:null,error:{message:'spend read refused'}});
     if(table==='marketing_kpis_daily')data=[{platform:'meta_ads',day_date:'2026-09-30',spend:300},{platform:'google_ads',day_date:'2026-09-30',spend:50}];
     if(table==='redo_marketing_daily')data=[{channel:'SMS',day_date:'2026-09-30',spend:12.5,spend_currency:'USD'}];
     // Completed sync windows; partialSpend leaves the ad platforms without one.
     if(table==='sync_jobs')data=['meta_ads_kpis','google_ads_kpis','tiktok_ads_kpis','redo_marketing'].filter(j=>!window.partialSpend||j==='redo_marketing').map(job_type=>({job_type,window:{startDate:'2026-09-01',endDate:'2026-10-01'}}));
     resolve({data,count:Array.isArray(data)?data.length:null});}};return q;}})};` }));
  const url=`http://127.0.0.1:${server.address().port}/v2/silo-attribution.html?start=2026-09-30&end=2026-09-30`;
  await page.goto(url);await page.waitForSelector('.attr-together',{timeout:10000}).catch(async e=>{console.error(await page.locator('body').innerText(),errors);throw e;});
  // Lead with money and teamwork: KPIs (incl. spend) and the headline are visible without opening anything.
  assert.match(await page.locator('.attr-together h2').innerText(),/88% of orders touched more than one channel/);assert.match(await page.locator('.attr-together').innerText(),/7 of all 8 orders\. 7 have identified channel evidence/);
  assert.equal(await page.locator('#spend').innerText(),'$362.50');assert.match(await page.locator('#roas').innerText(),/^2\.3x$/);
  assert.equal(await page.locator('#trust').evaluate(d=>d.open),false);assert.ok(await page.locator('.attr-scorecard').isVisible());
  const meta=page.locator('.attr-scorecard tbody tr',{hasText:'Meta Ads'});
  assert.match(await meta.innerText(),/\$300/);assert.match(await meta.innerText(),/\$300\s+\$0\s+0\.0x\s+\$233\s+0\.8x\s+7\s+0\s+0/);
  assert.match(await page.locator('.attr-scorecard tbody tr',{hasText:'Redo SMS'}).innerText(),/sending cost/);
  assert.match(await page.locator('.attr-findings').innerText(),/Meta Ads starts more journeys than it closes/);
  assert.match(await page.locator('.attr-findings').innerText(),/Google Ads mostly closes what others start/);
  // Paths carry dollars and open their orders, which open a journey.
  assert.match(await page.locator('.attr-journey-row').first().innerText(),/Meta Ads[\s\S]*Redo SMS[\s\S]*Google Ads[\s\S]*7 orders[\s\S]*\$700/);
  await page.locator('[data-path="0"]').first().click();await page.locator('#path-detail [data-order]').first().click();await page.waitForSelector('#journey[open]');assert.match(await page.locator('#flow').innerText(),/Meta Ads/);await page.locator('#close').click();await page.keyboard.press('Escape');
  await page.locator('[data-support="0"]').click();assert.match(await page.locator('#path-title').innerText(),/Meta Ads starts/);await page.keyboard.press('Escape');
  // A channel opens Journeys filtered to every order it appears in, not only the ones it was credited.
  await meta.locator('[data-channel]').click();assert.equal(await page.locator('#ordersection').isVisible(),true);assert.equal(await page.locator('#overview').isVisible(),false);
  assert.match(await page.locator('#count').innerText(),/^7 orders where Meta Ads appears/);
  await page.locator('#role').selectOption('credited');assert.match(await page.locator('#count').innerText(),/^0 orders/);
  await page.locator('#role').selectOption('started');assert.match(await page.locator('#count').innerText(),/^7 orders where Meta Ads started/);
  await page.locator('#overview-tab').click();
  // Trust & method holds reconciliation, coverage, spend sources and the what-if credit rules.
  await page.locator('#trust > summary').click();assert.match(await page.locator('#trust').innerText(),/1 of 1 day matched[\s\S]*Journey coverage[\s\S]*Spend sources/);
  await page.getByText('Try other credit rules',{exact:true}).click();await page.locator('#decay-days').fill('0');await page.locator('#compare-models').click();assert.match(await page.locator('#model-error').innerText(),/Half-life/);await page.locator('#decay-days').fill('7');await page.locator('#compare-models').click();assert.equal(await page.locator('#model-error').innerText(),'');
  await page.locator('#trust > summary').click();
  for(const theme of ['light','dark']){
   await page.evaluate(t=>{document.documentElement.setAttribute('data-theme',t);document.querySelector('.bcn-header-sub').textContent='SYNTHETIC FIXTURE PREVIEW — no production data';document.querySelector('.silo-main').scrollTop=0;window.scrollTo(0,0);},theme);
   assert.equal(await page.locator('#ordersection').isVisible(),false);
   const output=process.env.SILO_SCREENSHOT_DIR;if(output){fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,`attribution-desktop-${theme}.png`),fullPage:true});}
  }
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);await page.evaluate(()=>{document.querySelector('.silo-main').scrollTop=0;window.scrollTo(0,0);});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(process.env.SILO_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.SILO_SCREENSHOT_DIR,'attribution-mobile.png'),fullPage:true});
  await page.locator('#start').fill('2026-09-29');await page.locator('#start').dispatchEvent('change');assert.equal(await page.locator('#results').isVisible(),false);
  await page.locator('#start').fill('2026-09-30');await page.evaluate(()=>window.staleFixture=true);await page.locator('#load').click();await page.waitForFunction(()=>document.querySelector('#overview').textContent.includes('refreshed since'));assert.ok(await page.locator('.attr-scorecard').isVisible(),'stale journeys keep the scorecard');assert.equal(await page.locator('#spend').innerText(),'$362.50');assert.equal(await page.locator('#results').isVisible(),true);
  // Spend that does not cover the period is labelled known, and no return is computed from it.
  await page.evaluate(()=>{window.staleFixture=false;window.partialSpend=true;});await page.locator('#load').click();await page.waitForSelector('.attr-scorecard');
  assert.equal(await page.locator('#spend').innerText(),'$362.50 known');assert.equal(await page.locator('#roas').innerText(),'—');assert.match(await page.locator('#spendnote').innerText(),/Incomplete: Meta Ads, Google Ads/);
  assert.match(await page.locator('.attr-scorecard tbody tr',{hasText:'Meta Ads'}).innerText(),/\$300 partial\s+\$0\s+—/);assert.match(await page.locator('.attr-scorecard tfoot').innerText(),/\$363 known\s+\$825\s+—/);
  await page.evaluate(()=>{window.partialSpend=false;});
  // Spend failing never blanks the attribution; it says spend is unavailable.
  await page.evaluate(()=>{window.staleFixture=false;window.spendFail=true;});await page.locator('#load').click();await page.waitForSelector('.attr-scorecard');
  assert.equal(await page.locator('#spend').innerText(),'Unavailable');assert.match(await page.locator('#spendnote').innerText(),/spend read refused/);assert.match(await page.locator('.attr-together').innerText(),/88% of orders/);
  await page.evaluate(()=>{window.spendFail=false;window.emptyFixture=true;});await page.locator('#load').click();await page.waitForSelector('.attr-together');assert.match(await page.locator('.attr-together').innerText(),/No identified channel journeys/);
  assert.deepEqual(errors,[]);console.log('Attribution browser: KPIs+spend, teamwork, scorecard drilldown, role filter, trust section, desktop/mobile, light/dark, stale/spend-failure/empty states passed');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
