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
   window.fixture=${JSON.stringify({rows,records,controls,company,store})};window.savedTasks=[];
   window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{user:{id:'synthetic-user',email:'fixture@example.test'}}}})},rpc:async(name)=>({data:name==='nav_badge_counts'?{}:window.emptyFixture?[]:fixture.rows}),from(table){const filters={};let mode='select',payload;
    const q={select(){return q;},eq(k,v){filters[k]=v;return q;},gte(){return q;},lte(){return q;},in(k,v){filters[k]=v;return q;},order(){return q;},limit(){return q;},single(){return q;},maybeSingle(){return q;},insert(p){mode='insert';payload=p;return q;},then(resolve){
     if(mode==='insert'){const prior=savedTasks.find(x=>x.id===payload.id);if(prior)return resolve({error:{code:'23505'}});savedTasks.push(payload);return resolve({data:null});}
     let data=[];if(table==='profiles')data=typeof filters.id==='string'?{role:'admin',active_company_id:fixture.company}:[{id:'synthetic-user',name:'Synthetic reviewer'}];
     if(table==='entity_memberships')data=filters.user_id?{user_id:'synthetic-user'}:[{user_id:'synthetic-user'}];
     if(table==='shopify_connections')data=[{id:fixture.store,shop_domain:'synthetic.example.test'}];
     if(table==='shopify_attribution_days')data=window.emptyFixture?fixture.controls.map(c=>({...c,net_cents:0,total_cents:0})):fixture.controls;
     if(table==='shopify_attribution_orders')data=typeof filters.order_id==='string'?fixture.records.find(r=>r.order_id===filters.order_id):window.staleFixture?fixture.records.map(r=>({...r,fetched_at:'changed'})):fixture.records;
     if(table==='launch_tasks')data=savedTasks.find(t=>t.id===filters.id)||null;
     resolve({data});}};return q;}})};` }));
  const url=`http://127.0.0.1:${server.address().port}/v2/silo-attribution.html?start=2026-09-30&end=2026-09-30`;
  await page.goto(url);await page.waitForSelector('.attr-takeaway',{timeout:10000}).catch(async e=>{console.error(await page.locator('body').innerText(),errors);throw e;});
  assert.match(await page.locator('.attr-takeaway').innerText(),/7 orders/);
  assert.equal(await page.locator('#overview').count(),1);assert.equal(await page.locator('#legacy-overview').count(),1);
  await page.locator('[data-path="0"]').first().click();await page.locator('#path-detail [data-order]').first().click();await page.waitForSelector('#journey[open]');assert.match(await page.locator('#flow').innerText(),/Meta Ads/);await page.locator('#close').click();await page.keyboard.press('Escape');
  await page.locator('[data-draft="0"]').click();await page.locator('#draft-owner').selectOption('synthetic-user');await page.locator('#draft-date').fill(new Date(Date.now()+7*86400000).toISOString().slice(0,10));await page.locator('#save-review').click();await page.waitForSelector('#draft-status a');await page.locator('#save-review').click();assert.equal(await page.evaluate(()=>savedTasks.length),1);await page.keyboard.press('Escape');
  await page.getByText('Compare credit models (optional)',{exact:true}).click();await page.locator('#decay-days').fill('0');await page.locator('#compare-models').click();assert.match(await page.locator('#model-error').innerText(),/Half-life/);await page.locator('#decay-days').fill('7');await page.locator('#compare-models').click();assert.equal(await page.locator('#model-error').innerText(),'');await page.getByText('Compare credit models (optional)',{exact:true}).click();
  await page.locator('#journeys-tab').click();assert.equal(await page.locator('#ordersection').isVisible(),true);await page.locator('#overview-tab').click();
  await page.evaluate(()=>{document.documentElement.setAttribute('data-theme','dark');document.querySelector('.bcn-header-sub').textContent='SYNTHETIC FIXTURE PREVIEW — no production data';document.querySelector('.silo-main').scrollTop=0;window.scrollTo(0,0);});
  const output=process.env.SILO_SCREENSHOT_DIR;if(output){fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'attribution-desktop.png'),fullPage:true});}
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);await page.evaluate(()=>{document.querySelector('.silo-main').scrollTop=0;window.scrollTo(0,0);});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(output)await page.screenshot({path:path.join(output,'attribution-mobile.png'),fullPage:true});
  await page.locator('#start').fill('2026-09-29');await page.locator('#start').dispatchEvent('change');assert.equal(await page.locator('#results').isVisible(),false);
  await page.locator('#start').fill('2026-09-30');await page.evaluate(()=>window.staleFixture=true);await page.locator('#load').click();await page.waitForFunction(()=>document.querySelector('#overview').textContent.includes('refreshed since'));assert.equal(await page.locator('#results').isVisible(),true);
  await page.evaluate(()=>{window.staleFixture=false;window.emptyFixture=true;});await page.locator('#load').click();await page.waitForSelector('.attr-takeaway');assert.match(await page.locator('.attr-takeaway').innerText(),/Not enough/);assert.equal(await page.locator('[data-draft]').count(),0);
  assert.deepEqual(errors,[]);console.log('Attribution browser: desktop/mobile, dialogs, task retries, model validation, filter/stale/empty states passed');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
