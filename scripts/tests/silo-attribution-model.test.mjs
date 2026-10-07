import assert from 'node:assert/strict';
import {allocate,classify,cents} from '../../v2/silo-attribution-model.js';
const visit=(id,source,medium='',campaign='',time='2026-09-20T10:00:00Z')=>({id,occurredAt:time,source:source==='direct'?'direct':'an unknown source',landingPage:'https://www.baseballism.com/collections/caps',utmParameters:source==='direct'?null:{source,medium,campaign},__typename:'CustomerVisit'});
const order=(visits,extra={})=>({id:'gid://shopify/Order/123',name:'#123',createdAt:'2026-09-21T12:00:00Z',sourceName:'web',customerJourneySummary:{ready:true,firstVisit:visits[0]||null,lastVisit:visits.at(-1)||null,moments:{nodes:visits,pageInfo:{hasNextPage:false}}},...extra});
const meta=visit('m','facebook','paid','campaign');
const direct=visit('d','direct','','','2026-09-21T10:00:00Z');
assert.equal(allocate(order([meta,direct])).channel,'Meta Ads');
assert.equal(allocate(order([meta,visit('r','redo','sms','sale','2026-09-21T11:00:00Z')])).channel,'Redo SMS');
assert.equal(allocate(order([direct])).channel,'Direct');
assert.equal(allocate(order([])).channel,'Unattributed');
assert.equal(allocate(order([meta],{sourceName:'tiktok'})).channel,'TikTok Shop');
assert.equal(allocate(order([meta],{sourceName:'2329312'})).channel,'Meta Shop');
assert.equal(allocate(order([visit('old','facebook','paid','','2026-08-01T10:00:00Z')])).channel,'Unattributed');
assert.equal(allocate(order([visit('future','facebook','paid','','2026-09-22T10:00:00Z')])).channel,'Unattributed');
assert.equal(allocate(order([meta],{customerJourneySummary:{ready:false}})).channel,'Pending');
assert.throws(()=>allocate(order([meta],{customerJourneySummary:{ready:true,moments:{pageInfo:{hasNextPage:true}}}})),/Unpaginated/);
assert.equal(classify({source:'Facebook'}).channel,'Meta Social — Unspecified');
assert.equal(classify({source:'Google',sourceType:'SEO'}).channel,'Organic Search');
assert.equal(classify({source:'https://mail.yahoo.com/'}).channel,'Email — Other');
assert.equal(classify({source:'https://www.baseballism.com/'},{ownHosts:['www.baseballism.com']}).channel,null);
assert.equal(classify({source:'https://paypal.com/'}).channel,null);
assert.equal(classify({utmParameters:{source:'google',medium:'product_sync'}}).channel,'Google Organic Shopping');
assert.equal(classify({utmParameters:{source:'attentive',medium:'sms'}}).channel,'Attentive SMS');
const google={...visit('g','google'),source:'Google',sourceType:'SEO',utmParameters:null};
const raw={landing_path:'/collections/caps',tracking:{gclid:'click',gad_campaignid:'987'}};
assert.equal(allocate(order([google]),raw).channel,'Google Ads');
assert.equal(allocate(order([google,direct]),raw).channel,'Organic Search');
assert.equal(allocate(order([]),raw).assignment,'first_touch_fallback');
assert.equal(allocate(order([meta]),{...raw,tracking:{fbclid:'click'}}).channel,'Meta Ads');
assert.equal(allocate(order([google]),{...raw,tracking:{fbclid:'click'}}).channel,'Organic Search');
assert.equal(cents('0.01'),1);assert.equal(cents('-123.45'),-12345);assert.throws(()=>cents('1.005'));
console.log('25 attribution and monetary checks passed');

const early=visit('early','facebook','paid','','2026-09-01T12:00:00Z');
const redo=visit('redo','redo','email','','2026-09-21T10:00:00Z');
const chain=order([early,redo,direct]);
for(const days of [7,14,30,60]){
 const a=allocate(chain,null,null,{windowDays:days});
 assert.equal(a.channel,'Redo Email');assert.equal(a.weight,1);assert.equal(a.window_days,days);
 assert.equal(a.introduced_channel,days<30?'Redo Email':'Meta Ads');
 assert.deepEqual(a.assisting_channels,days<30?[]:['Meta Ads']);
}
assert.equal(allocate(order([early]),null,null,{windowDays:14}).channel,'Unattributed');
assert.equal(allocate(order([early]),null,null,{windowDays:30}).channel,'Meta Ads');
assert.throws(()=>allocate(chain,null,null,{windowDays:45}),/Unsupported/);
assert.equal(classify({source:'https://another-store.test/p'},{ownHosts:['another-store.test']}).channel,null);
assert.deepEqual(allocate(chain,null,null).assisting_channels,['Meta Ads']);
console.log('Window, introducing, assists and tenant storefront checks passed');

assert.equal(allocate(order([early]),raw,null,{windowDays:7}).channel,'Unattributed');
for(const [source,medium] of [['redo','email'],['facebook','paid']]){
 const internal={...visit('internal',source,medium),referrerUrl:'https://another-store.test/collections'};
 const options={ownHosts:['another-store.test']};
 assert.equal(classify(internal,options).channel,null);
 assert.equal(allocate(order([meta,internal]),raw,null,options).channel,'Meta Ads');
 const only=allocate(order([internal]),raw,null,options);
 assert.equal(only.channel,'Unattributed');assert.equal(only.introduced_channel,null);assert.deepEqual(only.assisting_channels,[]);
}
assert.equal(classify({...visit('checkout','redo','email'),referrerUrl:'https://paypal.com/checkout'}).channel,null);
