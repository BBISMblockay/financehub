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
    this.listeners={};this.innerHTML='';this.textContent='';
    // Enough of classList and addEventListener for the compact toggle: the
    // nav is data, not framework, and its behaviour is worth asserting here.
    const classes=new Set();
    this.classList={add:c=>classes.add(c),remove:c=>classes.delete(c),
      contains:c=>classes.has(c),toggle:(c,on)=>{const want=on===undefined?!classes.has(c):!!on;
        if(want)classes.add(c);else classes.delete(c);return want;}};
  }
  append(...values){this.children.push(...values);}
  setAttribute(k,v){this.attributes[k]=v;}
  getAttribute(k){return this.attributes[k];}
  addEventListener(type,fn){(this.listeners[type]=this.listeners[type]||[]).push(fn);}
  fire(type){for(const fn of this.listeners[type]||[])fn();}
}
const mountNav=(active)=>{
  const document={createElement:tag=>new Element(tag)},window={};
  vm.runInNewContext(nav,{window});
  vm.runInNewContext(suite,{window,document});
  let mounted;
  const main={querySelector:()=>mounted,firstElementChild:{after:node=>{mounted=node;}}};
  window.SiloAccounting.mount(main,active);
  return {window,main,nav:mounted,links:mounted.children[1].children,
    toggle:mounted.children[2],remount:()=>window.SiloAccounting.mount(main,active)};
};
test('all accounting destinations are one click away and the current page is identified',()=>{
  for(const active of ['finance/card-coding','finance/accounting-export','finance/qbo-reports','finance/schedules','finance/fixed-assets','finance/cash-forecast']){
    const m=mountNav(active);
    // 8, not 7: Invoicing joined ACCOUNTING_PAGES and this count was not
    // updated with it, so the suite had been red on main. Kept as a literal
    // rather than pages().length -- the point is that every destination is one
    // click away, and comparing the list to itself would assert nothing.
    assert.equal(m.links.length,8);assert.equal(m.links.filter(l=>l.attributes['aria-current']==='page').length,1);
    assert.ok(m.links.every(l=>l.href.startsWith('/v2/')));
    const first=m.nav;m.remount();assert.equal(first,m.nav);
    assert.equal(m.window.SiloAccounting.contains('inventory/overview'),false);
  }
});
test('every destination draws an icon and keeps its label as the accessible name',()=>{
  const {links}=mountNav('finance/card-coding');
  for(const link of links){
    // The icon is markup on the link; the LABEL is a real child text node, so
    // clipping it in compact mode cannot take the accessible name with it.
    assert.match(link.innerHTML,/^<svg /,'a destination drawn without an icon');
    assert.match(link.innerHTML,/stroke="currentColor"/,'the icon must follow the link colour');
    const text=link.children.find(child=>child.tag==='span');
    assert.ok(text&&text.textContent,'a destination with no label element');
    assert.equal(text.textContent,link.dataset.label,'the tooltip label and the visible label must agree');
    assert.equal(link.title,link.dataset.label);
  }
  // Distinct icons, not one mark repeated -- the fallback is allowed once.
  const drawings=new Set(links.map(l=>l.innerHTML.replace(/<span[\s\S]*$/,'')));
  assert.equal(drawings.size,links.length,'two destinations share an icon');
});
test('the compact toggle flips the nav and says which state it is in',()=>{
  const {nav,toggle}=mountNav('finance/card-coding');
  assert.equal(nav.classList.contains('accounting-suite--compact'),false);
  assert.equal(toggle.attributes['aria-pressed'],'false');
  const labelled=toggle.attributes['aria-label'];
  assert.ok(labelled&&labelled.length,'the toggle needs an accessible name of its own');
  toggle.fire('click');
  assert.equal(nav.classList.contains('accounting-suite--compact'),true);
  assert.equal(toggle.attributes['aria-pressed'],'true');
  assert.notEqual(toggle.attributes['aria-label'],labelled,'the name must describe what the click will do next');
  toggle.fire('click');
  assert.equal(nav.classList.contains('accounting-suite--compact'),false);
  assert.equal(toggle.attributes['aria-pressed'],'false');
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
