import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../../v2/finance-dialog.js',import.meta.url),'utf8');
function fixture(){
  const nodes=[];
  class Element{
    constructor(tag){this.tag=tag;this.style={};this.events={};this.children=[];this.value='';this.checked=false;nodes.push(this);}
    setAttribute(){}append(...nodes){this.children.push(...nodes);}focus(){}showModal(){this.open=true;}remove(){this.removed=true;}
    addEventListener(name,fn){this.events[name]=fn;}close(){this.open=false;this.events.close?.();}
  }
  const window={},document={createElement:tag=>new Element(tag),createTextNode:text=>({text}),body:new Element('body')};
  vm.runInNewContext(source,{window,document});return{window,nodes};
}
test('recovery dialog cannot confirm without checked authorization and a specific reason',async()=>{
  const h=fixture(),result=h.window.SiloFinanceDialog.ask({title:'Recovery',message:'Verify absence',reason:true,minLength:10,confirmation:'I checked QBO'});
  const input=h.nodes.find(n=>n.tag==='textarea'),check=h.nodes.find(n=>n.tag==='input'),submit=h.nodes.find(n=>n.type==='submit'),form=h.nodes.find(n=>n.tag==='form');
  assert.equal(submit.disabled,true);input.value='Verified exact journal reference';input.events.input();assert.equal(submit.disabled,true);
  form.events.submit({preventDefault(){}});assert.equal(h.nodes.find(n=>n.tag==='dialog').open,true);
  check.checked=true;check.events.change();assert.equal(submit.disabled,false);
  form.events.submit({preventDefault(){}});assert.equal(await result,'Verified exact journal reference');
});
test('closing a finance dialog returns no approval',async()=>{
  const h=fixture(),result=h.window.SiloFinanceDialog.ask({title:'Reopen',message:'Reason required',reason:true});
  h.nodes.find(n=>n.tag==='dialog').close();assert.equal(await result,null);
});
