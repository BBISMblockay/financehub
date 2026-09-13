// Generates an offline, synthetic browser fixture using the shipped page/code.
// No credentials, production IO, approval or posting endpoints are available.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..');
const output=process.argv[2]; if(!output)throw new Error('Provide a scratch output directory');
await mkdir(output,{recursive:true});
const fixture=String.raw`
const co={id:'synthetic-company'};
const records={
 profiles:[{name:'Demo Bookkeeper',email:'demo@example.invalid',role:'owner',department:'finance'}],
 card_sources:[{id:'checking',display_name:'Checking',source_key:'checking',source_type:'bank',ingest_mode:'plaid',is_active:true,qbo_connection_id:'qbo',credit_qbo_account_id:'bank',credit_qbo_account_name:'Operating checking',credit_qbo_account_type:'Bank',authoritative_from:'2026-08-01',posting_enabled:false},
 {id:'csv',display_name:'Columbia CC · CSV fixture',source_key:'csv',source_type:'card',ingest_mode:'csv',is_active:true,qbo_connection_id:'qbo',credit_qbo_account_id:'card',credit_qbo_account_name:'Columbia credit card',credit_qbo_account_type:'Credit Card',posting_enabled:true,column_map:{txn_date:'Date',description:'Description',amount:'Amount'}}],
 quickbooks_accounts:[{qbo_account_id:'bank',name:'Operating checking',account_type:'Bank'}, {qbo_account_id:'card',name:'Columbia credit card',account_type:'Credit Card'}, {qbo_account_id:'expense',name:'Office supplies',account_type:'Expense'}].map(a=>({...a,connection_id:'qbo',is_active:true})),
 quickbooks_locations:[],quickbooks_customers:[],quickbooks_vendors:[],card_coding_rules:[],
 plaid_connections:[{id:'connection',institution_name:'Platypus OAuth Bank',status:'active',environment:'sandbox',history_days_requested:90}],
 plaid_accounts:[{id:'plaid-checking',connection_id:'connection',source_id:'checking',name:'Checking',mask:'0000',type:'depository',subtype:'checking',iso_currency_code:'USD',current_balance:12480.50,available_balance:12090.50,balance_updated_at:new Date().toISOString(),last_synced_at:new Date().toISOString(),cursor:'synthetic-position'}],plaid_sync_exceptions:[],
 card_import_batches:[{id:'batch',source_id:'checking',source_name:'Checking',label:'September 2026',period_start:'2026-09-01',period_end:'2026-09-30',entry_date:'2026-09-30',origin:'plaid',status:'draft',txn_count:6,uncoded_count:6,source_posting_enabled:false,created_at:'2026-09-12'}],
 card_transactions:['Office Depot','Payroll settlement','Shopify payout','Internal transfer','Coffee shop','Purchase refund'].map((description,i)=>({id:'txn-'+i,batch_id:'batch',row_no:i+1,txn_date:'2026-09-'+String(12-i).padStart(2,'0'),description,merchant_norm:description.toLowerCase(),amount:[89.40,2500,-3100,750,12,-45][i],currency:'USD',status:'uncoded',accounting_treatment:'unknown',origin:'plaid',provider_status:'posted',provider_updated_at:'2026-09-12T00:00:00Z',raw:{description}}))
};
records.card_transactions=Array.from({length:36},(_,i)=>({...records.card_transactions[i%6],id:'txn-'+i,row_no:i+1,txn_date:'2026-09-'+String(12-i%12).padStart(2,'0')}));
for(const rows of Object.values(records)) for(const row of rows)row.company_entity_id=co.id;
class Query{
 constructor(table){this.table=table.replace(/_v$/,'');this.filters=[];this.op='select';this.start=0;this.end=Infinity;}
 select(){return this;}eq(k,v){this.filters.push(r=>r[k]===v);return this;}in(k,v){this.filters.push(r=>v.includes(r[k]));return this;}
 gte(k,v){this.filters.push(r=>r[k]>=v);return this;}lte(k,v){this.filters.push(r=>r[k]<=v);return this;}order(){return this;}limit(n){this.end=n;return this;}range(a,b){this.start=a;this.end=b+1;return this;}
 insert(rows){this.op='insert';this.rows=Array.isArray(rows)?rows:[rows];return this;}update(row){this.op='update';this.row=row;return this;}
 single(){this.one=true;return this;}maybeSingle(){this.one=true;return this;}
 then(resolve,reject){try{
 let rows=(records[this.table]||[]).filter(r=>this.filters.every(f=>f(r)));
 if(this.op==='insert'){rows=this.rows.map(r=>({id:crypto.randomUUID(),status:'uncoded',currency:'USD',...r}));(records[this.table]||=[]).push(...rows);}
 if(this.op==='update')rows.forEach(r=>Object.assign(r,this.row));
 if(this.table==='card_import_batches')rows=rows.map(r=>({...r,source_name:records.card_sources.find(s=>s.id===r.source_id)?.display_name}));
 rows=JSON.parse(JSON.stringify(rows.slice(this.start,this.end)));resolve({data:this.one?rows[0]||null:rows,error:null});
 }catch(e){reject(e);}}
}
const db={from:t=>new Query(t),auth:{getSession:async()=>({data:{session:{user:{id:'demo',email:'demo@example.invalid'},access_token:'synthetic-not-a-token'}}})},rpc:async(name,args)=>{
 if(name!=='apply_card_coding')throw new Error('Approval and posting are unavailable in this fixture');
 for(const patch of args.p_rows)Object.assign(records.card_transactions.find(t=>t.id===patch.id),patch);
 return {data:args.p_rows.length,error:null};
},functions:{invoke:async()=>({error:{message:'Provider calls are unavailable in this offline fixture'}})}};
window.__SILO_CONFIG__={SUPABASE_URL:'https://offline.invalid',SUPABASE_ANON_KEY:'synthetic',ensureActiveCompany:async()=>co};
window.supabase={createClient:()=>db};
localStorage.setItem('silo.theme',document.documentElement.dataset.theme);
window.fetch=async()=>({ok:true,json:async()=>({suggestions:[]})});
`;
let html=await readFile(path.join(root,'v2/transactions.html'),'utf8');
html=html.replace(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g,(tag,src)=>src==='../pages/config.js'?'<script>'+fixture+'</script>':/^https:/.test(src)||['v2-shell.js'].includes(src)?'':tag);
for(const match of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]) {const code=await readFile(path.join(root,'v2',match[1].split('?')[0]),'utf8');html=html.replace(match[0],()=>'<script>'+code+'</script>');}
for(const match of [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)]) {const css=await readFile(path.join(root,'v2',match[1].split('?')[0]),'utf8');html=html.replace(match[0],()=>'<style>'+css+'</style>');}
html=html.replace('</head>','<style>html,body{margin:0;height:100%}.silo-main{height:100vh;display:flex;flex-direction:column}.silo-app{display:flex;height:100vh}</style></head>');
for(const theme of ['light','dark'])await writeFile(path.join(output,theme+'.html'),html.replace('data-theme="light"','data-theme="'+theme+'"'));
for(const theme of ['light','dark'])await writeFile(path.join(output,theme+'-phone.html'),'<html><body style="margin:0"><iframe title="Phone preview" src="'+theme+'.html" style="border:0;width:390px;height:844px"></iframe></body></html>');
await writeFile(path.join(output,'statement.csv'),'Date,Description,Amount\n2026-09-10,Office Depot,25.00\n2026-09-11,Shipping supplies,12.50\n');
console.log(output);
