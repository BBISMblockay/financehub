// Explicit stage/apply CLI. Never imports token refresh or the replacement publisher.
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,link,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {collectDay,dayRange,sanitizeDiscountCodes} from './lib/shopify-attribution-evidence.mjs';
import {normalizeShopDomain,tokenNeedsRefresh} from './lib/shopify-auth-lib.mjs';
import {shopifyGraphql,shopifyql,fetchWithRetry} from './lib/shopify-sync-core.mjs';
import {loadCatalog} from './lib/silo-attribution-catalog.mjs';
import {allocationWindows} from '../v2/silo-attribution-model.js';

class AppendError extends Error {}
const uuid=/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
export const digest=text=>createHash('sha256').update(text).digest('hex');
// Publish a complete checkpoint atomically without replacing an existing artifact.
// Interrupted private temporary files are never considered resumable checkpoints.
export async function atomicStage(file,bytes,{write=writeFile,publish=link,remove=unlink}={}) {
 const temp=file+'.partial-'+randomUUID();
 try {await write(temp,bytes,{flag:'wx',mode:0o600});await publish(temp,file);}
 finally {await remove(temp).catch(()=>{});}
}
export function config(env) {
 const mode=env.ATTRIBUTION_APPEND_MODE||'stage',kind=env.ATTRIBUTION_APPEND_KIND||'codes';
 if(!['stage','apply'].includes(mode)||!['codes','day'].includes(kind))throw new AppendError('Invalid append mode/kind');
 if(env.ATTRIBUTION_COMMIT||env.ATTRIBUTION_MODE||env.ATTRIBUTION_PROBE_ORDER_ID)throw new AppendError('Legacy workflow inputs not accepted');
 const company=env.ATTRIBUTION_COMPANY_ID,connection=env.ATTRIBUTION_CONNECTION_ID,domain=normalizeShopDomain(env.ATTRIBUTION_SHOP_DOMAIN);
 if(!uuid.test(company||'')||!uuid.test(connection||'')||!domain)throw new AppendError('Explicit company, connection and domain required');
 const maxRequests=Number(env.ATTRIBUTION_MAX_REQUESTS||1000);
 if(!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>10000)throw new AppendError('Request budget must be 1–10000');
 if(mode==='apply'&&(!env.ATTRIBUTION_STAGE_FILE||!/^[a-f0-9]{64}$/.test(env.ATTRIBUTION_STAGE_SHA256||'')))throw new AppendError('Apply requires staged file and its SHA-256');
 if(mode==='stage'&&!env.ATTRIBUTION_STAGE_DIR)throw new AppendError('Private stage directory required');
 return {mode,kind,company,connection,domain,maxRequests,days:mode==='stage'?dayRange(env.ATTRIBUTION_START,env.ATTRIBUTION_END):[],
  dir:env.ATTRIBUTION_STAGE_DIR,file:env.ATTRIBUTION_STAGE_FILE,sha:env.ATTRIBUTION_STAGE_SHA256};
}
const checked=async q=>{const {data,error}=await q;if(error)throw new AppendError('Database operation failed');return data;};
export async function runAppend(env,{createClient,gql=shopifyGraphql,ql=shopifyql,fetcher=fetchWithRetry,
 read=readFile,write=writeFile,stageFile=atomicStage,makeDir=mkdir,now=()=>Date.now(),log=console.log}={}) {
 const cfg=config(env),started=now();let requests=0;
 // Validate file BEFORE credentials, including exact scope, version and age.
 let artifact;
 if(cfg.mode==='apply') {
  const bytes=await read(cfg.file,'utf8');
  if(digest(bytes)!==cfg.sha)throw new AppendError('Stage digest mismatch');
  artifact=JSON.parse(bytes);
  if(artifact.version!==1||artifact.company!==cfg.company||artifact.connection!==cfg.connection||artifact.domain!==cfg.domain
    ||!uuid.test(artifact.run_id||'')||!['codes','day'].includes(artifact.payload?.kind)
    ||!Number.isFinite(Date.parse(artifact.payload.collected_at))
    ||now()-Date.parse(artifact.payload.collected_at)>86400000)throw new AppendError('Stage scope/version/age mismatch; restage after 24h');
 }
 if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)throw new AppendError('Existing Supabase credentials required');
 const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const c=await checked(db.from('shopify_connections').select('id,company_entity_id,shop_domain,access_token,auth_method,token_expires_at,is_active,sync_enabled')
  .eq('id',cfg.connection).eq('company_entity_id',cfg.company).single());
 if(!c||c.shop_domain!==cfg.domain||!c.is_active||!c.sync_enabled||!c.access_token||tokenNeedsRefresh(c,now())
   ||c.token_expires_at&&(!Number.isFinite(Date.parse(c.token_expires_at))||Date.parse(c.token_expires_at)<=now()))throw new AppendError('Connection unavailable; no credential refresh performed');
 c.api_version='2026-07';
 const admit=()=>{if(now()-started>30*60*1000||requests>=cfg.maxRequests)throw new AppendError('Bounded workload exhausted; resume from staged artifacts');requests++;};
 const graph=async(...args)=>{admit();return gql(...args);};
 const analytics=async(...args)=>{admit();return ql(...args);};
 const preflight=await graph(c,'query AdditivePreflight { shop { myshopifyDomain ianaTimezone } currentAppInstallation { accessScopes { handle } } }');
 const scopes=new Set(preflight.currentAppInstallation?.accessScopes?.map(s=>s.handle));
 const kind=artifact?.payload.kind||cfg.kind;
 if(preflight.shop?.myshopifyDomain!==cfg.domain||!scopes.has('read_orders')||!scopes.has('read_all_orders')||(kind==='day'&&!scopes.has('read_reports')))throw new AppendError('Live Shopify identity/history scopes not verified');
 if(cfg.mode==='apply') {
  // Receipt is atomic with changes. A network error has uncertain outcome: replay the
  // same run ID; never invent a replacement ID or assume zero writes.
  try {
   const result=await checked(db.rpc('append_shopify_attribution',{p_company:cfg.company,p_connection:cfg.connection,p_domain:cfg.domain,p_run:artifact.run_id,p_payload:artifact.payload}));
   await write(cfg.file+'.receipt.json',JSON.stringify({run_id:artifact.run_id,sha256:cfg.sha,result})+'\n',{mode:0o600});
   log(JSON.stringify({mode:'apply',run_id:artifact.run_id,result}));return result;
  } catch {
   await write(cfg.file+'.attempt.json',JSON.stringify({run_id:artifact.run_id,sha256:cfg.sha,status:'failed_or_uncertain',action:'Read sync_jobs by run_id or replay this exact artifact'})+'\n',{mode:0o600});
   throw new AppendError('Apply failed or outcome uncertain; inspect/replay same run ID');
  }
 }
 await makeDir(cfg.dir,{recursive:true,mode:0o700});
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:preflight.shop.ianaTimezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now()));
 if(cfg.days.some(d=>d>=today))throw new AppendError('Only complete store-local days may be staged');
 const catalog=kind==='day'?await loadCatalog(db,cfg.company):null;
 const staged=[];
 const resume=async(label,day,candidates=null,missing=[])=>{
  let bytes;
  try{bytes=await read(join(cfg.dir,label+'.json'),'utf8');}catch(e){if(e.code==='ENOENT')return false;throw e;}
  const saved=JSON.parse(bytes);
  if(saved.version!==1||saved.company!==cfg.company||saved.connection!==cfg.connection||saved.domain!==cfg.domain
    ||saved.payload?.kind!==kind||saved.payload.day!==day)throw new AppendError('Existing stage scope conflict');
  if(candidates&&(JSON.stringify(saved.payload.candidate_ids)!==JSON.stringify(candidates)
    ||missing.some(id=>!saved.payload.orders.some(o=>o.order_id===id))))throw new AppendError('Stage candidate coverage changed; restage in a fresh directory');
  const receipt={mode:'resumed_stage',file:join(cfg.dir,label+'.json'),sha256:digest(bytes),day};
  staged.push(receipt);log(JSON.stringify(receipt));return true;
 };
 const save=async(payload,label)=>{
  const value={version:1,company:cfg.company,connection:cfg.connection,domain:cfg.domain,run_id:randomUUID(),payload};
  const bytes=JSON.stringify(value)+'\n',file=join(cfg.dir,label+'.json');
  await stageFile(file,bytes);
  const receipt={mode:'staged',file,sha256:digest(bytes),kind:payload.kind,day:payload.day,orders:payload.orders.length,requests};
  staged.push(receipt);log(JSON.stringify(receipt));
 };
 for(const day of cfg.days) {
  const snapshot=await checked(db.from('shopify_attribution_days').select('day,ledger').eq('company_entity_id',cfg.company).eq('connection_id',cfg.connection).eq('day',day).maybeSingle());
  if(kind==='day') {
   if(snapshot){log(JSON.stringify({day,status:'existing_day_skipped'}));continue;}
   if(await resume(day+'-day',day))continue;
   await collectDay(c,day,{gql:graph,ql:analytics,commit:true,now:()=>new Date(now()).toISOString(),decorate:e=>allocationWindows(e,catalog),
    rest:async(conn,id)=>{admit();const r=await fetcher(`https://${conn.shop_domain}/admin/api/${conn.api_version}/orders/${id}.json?fields=id,landing_site`,{headers:{'X-Shopify-Access-Token':conn.access_token}});if(!r.ok)throw new AppendError('Landing read failed');return(await r.json()).order;},
    publish:p=>save({kind:'day',day:p.p_day,currency:p.p_currency,timezone:p.p_timezone,ledger:p.p_ledger,orders:p.p_orders,net_cents:p.p_net,total_cents:p.p_total,collected_at:p.p_extracted},day+'-day')});
  } else {
   if(!snapshot){log(JSON.stringify({day,status:'missing_day_requires_day_stage'}));continue;}
   const ids=[...new Set(snapshot.ledger.map(l=>l.order_id))].sort();
   for(let offset=0;offset<ids.length;offset+=100) {
    const rows=await checked(db.from('shopify_attribution_orders').select('order_id,evidence').eq('company_entity_id',cfg.company).eq('connection_id',cfg.connection).in('order_id',ids.slice(offset,offset+100)).order('order_id'));
    if(rows.length!==Math.min(100,ids.length-offset))throw new AppendError('Missing ledger evidence row');
    if(await resume(day+'-codes-'+ids[offset],day,ids.slice(offset,offset+100),rows.filter(r=>r.evidence?.order?.discountCodes==null).map(r=>r.order_id)))continue;
    const orders=[];
    for(const row of rows) {
     if(row.evidence?.order?.discountCodes!=null)continue; // including malformed non-null: never overwrite it
     const data=await graph(c,'query AdditiveCodes($id:ID!) { order(id:$id) { id discountCodes } }',{id:'gid://shopify/Order/'+row.order_id});
     if(data.order===null){orders.push({order_id:row.order_id,discount_codes:null});continue;}
     if(data.order?.id!=='gid://shopify/Order/'+row.order_id||!Array.isArray(data.order.discountCodes)||data.order.discountCodes.some(x=>typeof x!=='string'))throw new AppendError('Invalid Shopify code evidence');
     orders.push({order_id:row.order_id,discount_codes:sanitizeDiscountCodes(data.order.discountCodes)});
    }
    if(orders.length)await save({kind:'codes',day,collected_at:new Date(now()).toISOString(),candidate_ids:ids.slice(offset,offset+100),orders},day+'-codes-'+ids[offset]);
   }
  }
 }
 log(JSON.stringify({mode:'stage',status:'bounded_window_scanned',artifacts:staged.length,requests,days:cfg.days}));
 return staged;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {const {createClient}=await import('@supabase/supabase-js');await runAppend(process.env,{createClient});}
 catch(error) {console.error(JSON.stringify({status:'stopped',message:error instanceof AppendError?error.message:'Upstream collection failed; completed stage artifacts are retained. No replacement publication.'}));process.exitCode=1;}
}
