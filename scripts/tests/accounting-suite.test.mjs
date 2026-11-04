import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const root=new URL('../../',import.meta.url);
const read=p=>readFile(new URL(p,root),'utf8');
const suite=await read('v2/accounting-suite.js');
const nav=await read('v2/nav-config.js');
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attributes={};
    this.listeners={};this.innerHTML='';this.textContent='';this.hidden=false;
    const classes=new Set();
    this.classList={add:c=>classes.add(c),remove:c=>classes.delete(c),
      contains:c=>classes.has(c),toggle:(c,on)=>{const want=on===undefined?!classes.has(c):!!on;
        if(want)classes.add(c);else classes.delete(c);return want;}};
  }
  append(...values){this.children.push(...values);}
  setAttribute(k,v){this.attributes[k]=v;}
  getAttribute(k){return this.attributes[k];}
  set href(v){this.attributes.href=String(v);}
  get href(){return this.attributes.href;}
  querySelector(sel){
    if(sel==='[data-accounting-context]')return this._context||null;
    if(sel==='[data-accounting-books]')return this._context?.children?.[0]||null;
    if(sel==='.bcn-header')return this._header||null;
    if(sel==='[data-accounting-sub]'||sel==='.bcn-header-sub')return this._sub||null;
    return null;
  }
  remove(){this._removed=true;}
}
const mountContext=(active)=>{
  const document={createElement:tag=>new Element(tag)},window={};
  vm.runInNewContext(nav,{window});
  vm.runInNewContext(suite,{window,document});
  const header=new Element('header');header.className='bcn-header';
  const title=new Element('div');title.className='bcn-header-title';title.textContent='Page';
  header.children.push(title);
  header.querySelector=function(sel){
    if(sel==='[data-accounting-sub]'||sel==='.bcn-header-sub')return this._sub||null;
    if(sel==='.bcn-header-title')return title;
    return null;
  };
  title.after=function(node){header._sub=node;header.children.push(node);};
  const main={_header:header,
    querySelector(sel){
      if(sel==='[data-accounting-context]'||sel==='[data-accounting-close]'||sel==='[data-accounting-suite]')return null;
      if(sel==='.bcn-header')return this._header;
      return null;
    },
    firstElementChild:header,
  };
  window.SiloAccounting.mount(main, active);
  return { window, main, sub: header._sub };
};
test('accounting pages get subtitles only, no inset nav band',()=>{
  for(const active of ['finance/card-coding','finance/accounting-export','finance/qbo-reports']){
    const {main,sub,window}=mountContext(active);
    assert.ok(sub?.textContent?.length,'page subtitle applied');
    assert.equal(main.querySelector('[data-accounting-context]'),null);
    window.SiloAccounting.mount(main,active);
    assert.equal(window.SiloAccounting.contains('inventory/overview'),false);
  }
});
test('every accounting destination remains in the sidebar',()=>{
  const window={};vm.runInNewContext(nav,{window});
  assert.equal(window.SiloNav.ACCOUNTING_PAGES.length,8);
  for(const [id,,path] of window.SiloNav.ACCOUNTING_PAGES){
    assert.ok(id&&path,`${id} has a route`);
  }
});
test('one sidebar entry retains the existing finance department visibility',()=>{
  const window={};vm.runInNewContext(nav,{window});
  const entries=window.SiloNav.NAV_ITEMS.filter(x=>['finance/accounting','finance/card-coding','finance/accounting-export','finance/qbo-reports','finance/schedules','finance/fixed-assets','finance/cash-forecast'].includes(x.id));
  assert.equal(entries.length,1);assert.equal(entries[0].href,'/v2/transactions.html');
  assert.deepEqual([...entries[0].departments],['exec','finance']);
  for(const profile of ['standard','grandfathered'])for(const dept of ['finance','exec','logistics']){
    const links=window.SiloNav.navSectionsForProfile(profile,dept,'employee').flatMap(s=>s.items);
    assert.equal(links.some(x=>x.id==='finance/accounting'),dept!=='logistics');
  }
});
test('legacy route retains query/hash and records the original OAuth callback only for OAuth',async()=>{
  const html=await read('v2/card-coding.html'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  for(const search of ['','?batch=example','?oauth_state_id=callback&extra=one']){
    const saved=new Map(),anchor={};let next;
    const location={href:'https://silo.test/v2/card-coding.html'+search+'#review',search,hash:'#review',replace:url=>next=url};
    vm.runInNewContext(script,{document:{getElementById:()=>anchor},location,URLSearchParams,sessionStorage:{setItem:(k,v)=>saved.set(k,v)}});
    assert.equal(next,'./transactions.html'+search+'#review');
    assert.equal(anchor.href,next);
    assert.equal(saved.get('silo-plaid-legacy-return'),search.includes('oauth_state_id')?location.href:undefined);
  }
});

test('storage access and write failures cannot strand an OAuth callback',async()=>{
  const html=await read('v2/card-coding.html'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  for(const failure of ['get','set']) {
    const anchor={};let next;
    const location={href:'https://silo.test/v2/card-coding.html?oauth_state_id=callback#return',search:'?oauth_state_id=callback',hash:'#return',replace:url=>next=url};
    const context={document:{getElementById:()=>anchor},location,URLSearchParams};
    Object.defineProperty(context,'sessionStorage',{get(){if(failure==='get')throw new Error('Storage denied');return{setItem(){throw new Error('Quota exceeded');}};}});
    vm.runInNewContext(script,context);
    assert.equal(next,'./transactions.html?oauth_state_id=callback#return');
    assert.equal(anchor.href,next);
  }
});
test('fallback link retains the callback when automatic navigation fails',async()=>{
  const html=await read('v2/card-coding.html'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const anchor={};
  const context={document:{getElementById:()=>anchor},URLSearchParams,sessionStorage:{setItem(){}},location:{href:'https://silo.test/v2/card-coding.html?oauth_state_id=callback#return',search:'?oauth_state_id=callback',hash:'#return',replace(){throw new Error('Navigation unavailable');}}};
  assert.throws(()=>vm.runInNewContext(script,context),/Navigation unavailable/);
  assert.equal(anchor.href,'./transactions.html?oauth_state_id=callback#return');
});

test('cached navigation metadata cannot throw and newly available metadata is used',()=>{
 const window={SiloNav:{}};vm.runInNewContext(suite,{window});
 assert.equal(window.SiloAccounting.contains('finance/books'),false);
 window.SiloAccounting.mount({querySelector:()=>null},'finance/books');
 vm.runInNewContext(nav,{window});
 assert.equal(window.SiloAccounting.contains('finance/books'),true);
});
