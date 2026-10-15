'use strict';
// Real frontend pages, isolated fixture transport. Backend enforcement is in
// scripts/tests/on-deck-review-action.test.mjs, not in this mock.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { startSuite, fakeSupabaseScript } = require('../lib/harness');
const id = '11111111-1111-4111-8111-111111111111', outputId = '22222222-2222-4222-8222-222222222222';
const content = () => ({ recommend:true,subject:'Search hypothesis',summary:'Review without assumed lift.',body:'Grounded draft body.',reason:'Observed page evidence.',missing:['Confirm supported claim'],optional_context:['Compare prior test history'],proposed_title:'',proposed_meta_description:'',tasks:[] });
const tables = () => ({ profiles:[{id:'test-user',role:'admin',email:'reviewer@example.test'}],on_deck_settings:[{enabled:true,workflows:['seo','launch','ads','restock']}],on_deck_proposals:[{id,company_entity_id:'test-company',kind:'seo',title:'Search · Classic tees',status:'needs_info',version:2,source_version:'current',valid_until:'2099-01-01',selection_reason:'Selected #1 from measured search evidence.',source:{url:'https://example.test/tees',impressions:30000,clicks:175,position:7,days:26,inspection:{title:'Classic tees',meta_description:'Current snippet'}},content:content()}],on_deck_events:[],on_deck_attempts:[] });
const rpc = {
 on_deck_can_review:()=>true,on_deck_coding_access:()=>({review:false,post:false}),
 on_deck_review_state:()=>({review_contract:2,drift_warns:true,seo:true,purchasing:true,proposals:window.__FIXTURE_TABLES__.on_deck_proposals.map(p=>({id:p.id,source_current:p.source_version==='current',preparation:p.preparation_state||{state:p.status==='failed'?'paused':'idle',reason:p.status==='failed'?'disabled':null}})),context_tasks:[],tasks:[{id:'public-replacement',task_title:'Replacement public task',assigned_to_user_id:'owner',status:'open'}],assignees:[{id:'owner',name:'Task owner'}]}),
 on_deck_context:a=>{const p=window.__FIXTURE_TABLES__.on_deck_proposals[0];if(p.version!==a.p_version)throw new Error('Proposal changed. Reload.');if(a.p_action==='detach')p.context_work={};else p.context_work={state:'open',task_id:a.p_task,title:'Replacement public task'};p.version++;return p;},
 on_deck_decide:a=>{
  const p=window.__FIXTURE_TABLES__.on_deck_proposals[0];
  if(a.p_action==='approve'&&p.status==='completed')return p;
  if(p.version!==a.p_version)throw new Error('Proposal changed. Reload saved version.');
  if(['edit','approve'].includes(a.p_action)&&p.source_version!=='current')throw new Error('Evidence changed. Refresh before saving.');
  if(a.p_action==='edit'){
   p.content=a.p_content;p.status=p.content.missing.length||(p.kind==='seo'&&(!p.content.proposed_title||!p.content.proposed_meta_description))?'needs_info':'ready';
  }else if(a.p_action==='approve'){
   if(p.status!=='ready')throw new Error('Incomplete draft');
   window.__CREATIONS__=(window.__CREATIONS__||0)+1;window.__CREATED__=structuredClone(p.content);p.status='completed';
   p.output={kind:p.kind==='launch'?'launch_tasks':'seo_task',id:'22222222-2222-4222-8222-222222222222',ids:['22222222-2222-4222-8222-222222222222'],label:'Draft created'};
  }else if(a.p_action==='refresh'){p.status='failed';p.source_version='';}
  p.version++;
  if(window.__FAIL_AFTER_SAVE__){window.__FAIL_AFTER_SAVE__=false;throw new Error('Network interrupted after save. Reload saved version before retrying.');}
  return p;
 }
};
(async()=>{
 const suite=await startSuite({secureContext:true});
 if (process.env.FRONT_REVIEW_MUTATE) {
  const root=path.resolve(__dirname,'../../');
  const mutations={
   'freshness':['on-deck-briefing.js',"installed && typeof p.source_current === 'boolean' && p.source_version !== '' &&",'installed && true &&'],
   'full-draft':['on-deck-briefing.js',"if (!text(c.proposed_title)) blockers.push('Proposed SEO title is required.');",""],
   'saved-answer':['on-deck-briefing.js',"if (Array.isArray(c.review_inputs)) return c.review_inputs.map(i => ({ ...i, research: i.requirement === 'optional' }));",""],
   'private-context':['on-deck.js',"'Linked context task is unavailable. It may have been deleted or access changed. Detach the link to continue; its contents are not shown.'","work.title"],
   'dialog-lock':['on-deck.js','controls.forEach(b => { b.disabled = true; });',''],
   'exact-result':['on-deck.js',"seo_task: '/v2/seo-tasks.html?task='","seo_task: '/v2/seo-tasks.html#'"],
  };
  const [file,before,after]=mutations[process.env.FRONT_REVIEW_MUTATE]||[];assert.ok(file);const source=fs.readFileSync(path.join(root,file),'utf8');assert.ok(source.includes(before));
  await suite.context.route('**/v2/'+file,r=>r.fulfill({contentType:'text/javascript',body:source.replace(before,after)}));
 }
 await suite.context.route('**/v2/lib/supabase-js.min.js',r=>r.fulfill({contentType:'text/javascript',body:fakeSupabaseScript().replace('all = all(args) || [];','all = all(args);')}));
 const ready=()=>!document.getElementById('workspace').hidden;
 const open=(data=tables(),opts={})=>suite.open('/v2/on-deck.html?proposal='+id,data,{rpc,ready,...opts});
 let page,checks=0;const test=async(label,fn)=>{await fn();console.log(`ok ${++checks} - ${label}`);};
 const review=()=>page.getByRole('button',{name:'Review draft',exact:true}).click();
 const save=async()=>{await page.locator('#edit-note').fill('Reviewed evidence, copy and saved task inputs.');await page.getByRole('button',{name:'Save for review',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('edit-dialog').open);};
 const shots=path.resolve(__dirname,'../../../.screenshots');fs.mkdirSync(shots,{recursive:true});
 try {
  await test('incomplete stored ready output is blocked and repairable without an AI request',async()=>{const data=tables();Object.assign(data.on_deck_proposals[0],{status:'ready',content:{...content(),missing:[],proposed_meta_description:'Grounded metadata'}});page=await open(data);assert.equal(await page.getByRole('button',{name:'Create draft SEO task',exact:true}).isDisabled(),true);assert.match(await page.locator('#detail').textContent(),/Needs input/i);assert.equal(await page.getByRole('button',{name:'Review draft',exact:true}).isEnabled(),true);await page.close();});
  page=await open();
  await test('single review path places evidence, manual SEO fields and editable inputs together',async()=>{
   assert.equal(await page.getByRole('button',{name:'Prepare draft task',exact:true}).count(),0);
   assert.equal(await page.getByRole('button',{name:'Edit draft',exact:true}).count(),0);
   await review();assert.match(await page.locator('#edit-evidence-content').textContent(),/Current title: Classic tees/);
   assert.match(await page.locator('#edit-blockers').textContent(),/Proposed SEO title/);
   assert.equal(await page.locator('#edit-note').getAttribute('required'),'');assert.equal(await page.locator('#edit-note').getAttribute('minlength'),'12');
   await page.getByLabel('Confirm supported claim',{exact:true}).fill('Approved brief revision 4 confirms the claim.');
   await page.locator('#edit-missing [data-carry]').check();await save();
   assert.equal(await page.getByRole('button',{name:'Create draft SEO task',exact:true}).isDisabled(),true);assert.match(await page.locator('#detail').textContent(),/Approved brief revision 4/);
   assert.match(await page.locator('#detail').textContent(),/Proposed SEO title is required/);assert.doesNotMatch(await page.locator('#detail').textContent(),/older draft/);
  });
  await test('answer remains visible and editable; reopen restores blocking and manual copy finishes review',async()=>{
   await review();assert.match(await page.getByLabel('Confirm supported claim',{exact:true}).inputValue(),/revision 4/);
   await page.locator('#edit-missing [data-reopen]').first().check();await save();assert.equal(await page.evaluate(()=>window.__FIXTURE_TABLES__.on_deck_proposals[0].content.missing.length),1);
   await review();assert.equal(await page.locator('#edit-missing [data-reopen]').first().isChecked(),true);await page.locator('#edit-summary').fill('Review other fields while this answer remains open.');await save();assert.equal(await page.evaluate(()=>window.__FIXTURE_TABLES__.on_deck_proposals[0].content.missing.length),1);
   await review();await page.getByLabel('Confirm supported claim',{exact:true}).fill('Approved brief revision 5 corrects the claim.');await page.locator('#edit-missing [data-reopen]').first().uncheck();
   await page.locator('#edit-subject').fill('Reviewed SEO task title');await page.locator('#edit-body').fill('Reviewed SEO task copy.');await page.locator('#edit-seo-title').fill('Classic baseball tees | Example');await page.locator('#edit-seo-meta').fill('Explore classic baseball tees with grounded page copy.');
   await page.locator('#edit-dialog').evaluate(d=>d.scrollTop=0);
   await page.screenshot({path:path.join(shots,'on-deck-review-desktop.png'),fullPage:true});
   await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));await page.screenshot({path:path.join(shots,'on-deck-review-dark.png'),fullPage:true});await page.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));
   await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(shots,'on-deck-review-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});
   await save();assert.equal(await page.getByRole('button',{name:'Create draft SEO task',exact:true}).isEnabled(),true);
   assert.equal(await page.evaluate(()=>window.__QUERIES__.filter(q=>q.table==='rpc:on_deck_request_preparation').length),0);
  });
  await test('separate confirmation creates once, retains reviewed fields and links exact result',async()=>{
   await page.getByRole('button',{name:'Create draft SEO task',exact:true}).click();
   await page.evaluate(()=>{const original=window.__SILO_CONFIG__.ensureActiveCompany;window.__SILO_CONFIG__.ensureActiveCompany=async(...a)=>{await new Promise(r=>window.__RELEASE__=r);window.__SILO_CONFIG__.ensureActiveCompany=original;return original(...a);};});
   await page.getByRole('button',{name:'Confirm · Create draft SEO task'}).click();await page.waitForFunction(()=>!!window.__RELEASE__);
   assert.equal(await page.locator('#decision-submit').isDisabled(),true);await page.evaluate(()=>document.getElementById('decision-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await page.keyboard.press('Escape');assert.equal(await page.locator('#decision-dialog').evaluate(d=>d.open),true);await page.evaluate(()=>window.__RELEASE__());await page.waitForFunction(()=>!document.getElementById('decision-dialog').open);
   assert.equal(await page.evaluate(()=>window.__CREATIONS__),1);assert.equal(await page.evaluate(()=>window.__CREATED__.subject),'Reviewed SEO task title');assert.equal(await page.evaluate(()=>window.__CREATED__.review_inputs[0].answer),'Approved brief revision 5 corrects the claim.');
   assert.match(await page.getByRole('link',{name:'Open created SEO task'}).first().getAttribute('href'),new RegExp('/v2/seo-tasks.html\\?task='+outputId+'$'));
   assert.equal(await page.locator('[data-view=completed] b').textContent(),'1');assert.equal(await page.locator('[data-view=closed]').count(),0);assert.match(await page.locator('#queue').textContent(),/Created draft work/);
  });await page.close();
  await test('refresh while off/credit exhausted retains draft with honest paused recovery',async()=>{
   const data=tables();data.on_deck_settings[0].enabled=false;Object.assign(data.on_deck_proposals[0],{status:'ready',content:{...content(),missing:[],proposed_title:'Saved title',proposed_meta_description:'Saved meta'}});page=await open(data);await page.getByRole('button',{name:'Refresh evidence'}).click();await page.waitForFunction(()=>window.__FIXTURE_TABLES__.on_deck_proposals[0].source_version==='');
   assert.equal(await page.locator('.od-card[aria-pressed=true]').count(),1);assert.match(await page.locator('#detail').textContent(),/Paused.*Background preparation is off/);assert.match(await page.locator('.od-paper').textContent(),/Grounded draft body/);assert.equal(await page.getByRole('button',{name:'Review draft',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('link',{name:'Review preparation settings'}).count(),1);
   await page.close();const credit=tables();Object.assign(credit.on_deck_proposals[0],{status:'preparing',preparation_state:{state:'paused',reason:'credit_exhausted'}});page=await open(credit);assert.match(await page.locator('#detail').textContent(),/credit is exhausted/);assert.doesNotMatch(await page.locator('#detail').textContent(),/Preparation is running/);
   // The heading and every queue card read the same status as the paragraph: a
   // row paused on credit used to head itself "SILO is preparing this".
   assert.match(await page.locator('.od-detail-head').textContent(),/Paused/);assert.doesNotMatch(await page.locator('.od-detail-head').textContent(),/preparing this/);
   for(const label of await page.locator('.od-state').allTextContents())assert.match(label,/Paused/);
   await page.screenshot({path:path.join(shots,'on-deck-review-paused.png'),fullPage:true});await page.close();
   const heads={queued:/Queued to prepare/,running:/SILO is preparing this/,failed:/Preparation did not finish/};
   for(const state of ['queued','running','failed']){const data=tables();Object.assign(data.on_deck_proposals[0],{status:'preparing',preparation_state:{state,reason:state==='running'?'reserved':state==='queued'?'drafting':'preparation_failed'}});page=await open(data);assert.match(await page.locator('#detail').textContent(),new RegExp(state[0].toUpperCase()+state.slice(1)));assert.match(await page.locator('.od-detail-head').textContent(),heads[state]);for(const label of await page.locator('.od-state').allTextContents())assert.match(label,heads[state]);await page.close();}
  });
  await test('inaccessible context is hidden, detached with reason and replaced safely',async()=>{
   const data=tables();data.on_deck_proposals[0].context_work={state:'open',task_id:'private-task',title:'PRIVATE SECRET CONTENT'};page=await open(data);assert.doesNotMatch(await page.locator('#detail').textContent(),/PRIVATE SECRET/);assert.equal(await page.getByRole('link',{name:'Open context task'}).count(),0);
   await page.getByRole('button',{name:'Detach context link'}).click();await page.locator('#context-detach-note').fill('Private link unavailable; use public evidence work.');await page.getByRole('button',{name:'Confirm detach'}).click();await page.waitForFunction(()=>!document.getElementById('context-dialog').open);
   await page.getByRole('button',{name:'Assign context work'}).click();await page.getByLabel('Or link existing owned work').selectOption('public-replacement');await page.getByRole('button',{name:'Confirm context task'}).click();await page.waitForFunction(()=>!document.getElementById('context-dialog').open);assert.equal(await page.evaluate(()=>window.__FIXTURE_TABLES__.on_deck_proposals[0].context_work.task_id),'public-replacement');await page.close();
  });
  await test('uncertain Save keeps edits and offers reload without a duplicate write',async()=>{
   page=await open();await review();await page.locator('#edit-subject').fill('Saved before response interruption');await page.evaluate(()=>window.__FAIL_AFTER_SAVE__=true);await page.locator('#edit-note').fill('Review retained after uncertain network outcome.');await page.getByRole('button',{name:'Save for review',exact:true}).click();await page.waitForFunction(()=>/interrupted/.test(document.getElementById('edit-error').textContent));assert.equal(await page.locator('#edit-dialog').evaluate(d=>d.open),true);assert.equal(await page.locator('#edit-subject').inputValue(),'Saved before response interruption');await page.getByRole('button',{name:'Reload saved version'}).click();await page.waitForFunction(()=>document.getElementById('edit-dialog').open&&document.getElementById('edit-error').hidden);assert.equal(await page.locator('#edit-subject').inputValue(),'Saved before response interruption');assert.equal(await page.evaluate(()=>window.__QUERIES__.filter(q=>q.table==='rpc:on_deck_decide').length),1);await page.close();
  });
  await test('launch rows can be added/removed and unique titles are explained before Save',async()=>{
   const data=tables();const p=data.on_deck_proposals[0];p.kind='launch';p.content={...content(),missing:[],optional_context:[],tasks:[{title:'Email',detail:'Draft email'}]};page=await open(data);await review();await page.getByRole('button',{name:'Add launch task'}).click();await page.getByLabel('Launch task title').nth(1).fill('Email');assert.match(await page.locator('#edit-blockers').textContent(),/unique/);await page.getByLabel('Launch task title').nth(1).fill('Social');await page.getByRole('button',{name:'Remove task'}).first().click();await save();assert.equal(await page.evaluate(()=>window.__FIXTURE_TABLES__.on_deck_proposals[0].content.tasks[0].title),'Social');await page.close();
  });
  await test('exact SEO and idea destinations load only the company-scoped record; unavailable links fail safely',async()=>{
   const task={id:outputId,company_entity_id:'test-company',title:'Reviewed exact SEO task',approval_status:'draft',created_by:'test-user',created_at:'2026-10-14',proposed_title:'Reviewed title',proposed_meta_description:'Reviewed meta',proposed_body:'Reviewed body'};
   page=await suite.open('/v2/seo-tasks.html?task='+outputId,{seo_tasks:[task,{...task,id:'other-task',title:'Other work'}],seo_task_publications:[],profiles:[]},{ready:()=>!!document.querySelector('#list .st-task'),rpc:{can_approve_seo_tasks:true}});
   assert.equal(await page.locator('#list .st-task').count(),1);assert.match(await page.locator('#list').textContent(),/Reviewed exact SEO task/);assert.equal(await page.evaluate(()=>document.activeElement.dataset.task),'22222222-2222-4222-8222-222222222222');
   const query=await page.evaluate(()=>window.__QUERIES__.find(q=>q.table==='seo_tasks'));assert.ok(query.filters.some(f=>f.col==='id'&&f.val==='22222222-2222-4222-8222-222222222222'));assert.ok(query.filters.some(f=>f.col==='company_entity_id'&&f.val==='test-company'));await page.close();
   page=await suite.open('/v2/seo-tasks.html?task='+outputId,{seo_tasks:[{...task,company_entity_id:'other-company',title:'FOREIGN SECRET'}],seo_task_publications:[]},{ready:()=>/unavailable/.test(document.getElementById('status').textContent),rpc:{can_approve_seo_tasks:true}});assert.doesNotMatch(await page.locator('body').textContent(),/FOREIGN SECRET/);await page.close();
   const idea={id:outputId,company_entity_id:'test-company',title:'Reviewed exact idea',hook:'Reviewed hook',body_draft:'Reviewed body',status:'idea',baseline_ad_ids:[],live_ad_ids:[],baseline_snapshot:null};
   page=await suite.open('/v2/ad-studio.html?view=ideas&idea='+outputId,{ad_ideas:[idea,{...idea,id:'other-idea',title:'Other idea'}],ad_studio_ads:[]},{ready:()=>!!document.querySelector('#board [data-idea]')});assert.equal(await page.locator('#board [data-idea]').count(),1);assert.equal(await page.evaluate(()=>document.activeElement.dataset.idea),'22222222-2222-4222-8222-222222222222');await page.getByRole('button',{name:'Edit',exact:true}).click();assert.equal(await page.locator('#iBody').inputValue(),'Reviewed body');await page.close();
   page=await suite.open('/v2/ad-studio.html?view=ideas&idea='+outputId,{ad_ideas:[{...idea,company_entity_id:'other-company',title:'FOREIGN SECRET'}],ad_studio_ads:[]},{ready:()=>/unavailable/.test(document.getElementById('status').textContent)});assert.doesNotMatch(await page.locator('body').textContent(),/FOREIGN SECRET/);await page.close();
  });
  await test('created work and dismissed/skipped opportunities are distinct within existing Outcomes',async()=>{
   const data=tables(),original=data.on_deck_proposals[0];original.status='completed';original.output={kind:'seo_task',id:outputId,label:'SEO draft created'};
   data.on_deck_proposals.push({...original,id:'33333333-3333-4333-8333-333333333333',status:'dismissed',title:'Search · Dismissed opportunity',output:null,dismiss_reason:'Not a current priority.'},{...original,id:'44444444-4444-4444-8444-444444444444',status:'screened',title:'Search · Skipped opportunity',output:null});
   page=await open(data);assert.equal(await page.locator('#views button').count(),4);assert.match(await page.locator('#queue').textContent(),/Created draft work[\s\S]*Dismissed \/ skipped opportunities/);await page.locator('.od-card').filter({hasText:'Dismissed opportunity'}).click();await page.getByRole('button',{name:'Outcome',exact:true}).click();assert.match(await page.locator('#detail').textContent(),/Opportunity dismissed; no draft work was created/);assert.equal(await page.locator('#detail a[href*="seo-tasks.html?task="]').count(),0);await page.close();
  });
  console.log(`${checks} real-page review-to-action browser scenarios passed with isolated mocked transport; no live backend/provider verification.`);
 }finally{await suite.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
