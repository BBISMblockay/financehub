import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const root=new URL('../../',import.meta.url);
const read=p=>readFile(new URL(p,root),'utf8');
const suite=await read('v2/accounting-suite.js');
const nav=await read('v2/nav-config.js');
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attributes={};}
  append(value){this.children.push(value);}
  setAttribute(k,v){this.attributes[k]=v;}
}
test('all accounting destinations are one click away and the current page is identified',()=>{
  const document={createElement:tag=>new Element(tag)},window={};
  vm.runInNewContext(suite,{window,document});
  for(const active of ['finance/card-coding','finance/accounting-export','finance/qbo-reports','finance/schedules','finance/fixed-assets','finance/cash-forecast']){
    let mounted;
    const main={querySelector:()=>mounted,firstElementChild:{after:node=>{mounted=node;}}};
    window.SiloAccounting.mount(main,active);
    const links=mounted.children[1].children;
    assert.equal(links.length,6);assert.equal(links.filter(l=>l.attributes['aria-current']==='page').length,1);
    assert.ok(links.every(l=>l.href.startsWith('/v2/')));
    const first=mounted;window.SiloAccounting.mount(main,active);assert.equal(first,mounted);
  }
  assert.equal(window.SiloAccounting.contains('inventory/overview'),false);
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
    const saved=new Map();let next;
    const location={href:'https://silo.test/v2/card-coding.html'+search+'#review',search,hash:'#review',replace:url=>next=url};
    vm.runInNewContext(script,{location,URLSearchParams,sessionStorage:{setItem:(k,v)=>saved.set(k,v)}});
    assert.equal(next,'./transactions.html'+search+'#review');
    assert.equal(saved.get('silo-plaid-legacy-return'),search.includes('oauth_state_id')?location.href:undefined);
  }
});
