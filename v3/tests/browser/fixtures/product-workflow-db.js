// Offline fixture for the real preview page. No network/auth credentials.
(function () {
  const tables = {
    profiles:[{id:'U1',role:'owner',email:'test@example.test'}],
    factories:[{id:'F1',company_entity_id:'C1',factory_name:'Test factory'}],
    product_concepts:[{id:'CPT1',company_entity_id:'C1',title:'Practice tee',status:'draft',concept_summary:'Wear it every day',suggested_factory_id:'F1',suggested_size_breakdown:{S:40,M:60},suggested_marketing_copy:'Unapproved copy',audience:'Players',marketing_angle:'Everyday baseball',suggested_launch_date:'2026-11-01'}],
    products_master:[{id:'P1',company_entity_id:'C1',product_title:'Catalog tee',sku:'TEE-M',variant_title:'M',lead_time_days:30,target_stock_days:60}],
    product_workflow_briefs:[],po_headers:[],po_lines:[],product_tracker:[],launch_product_readiness:[],entity_memberships:[],
  };
  const state=window.__pw={tables,calls:[],canWrite:!window.__pwViewer,failSave:false,failPipeline:false};
  function from(table) {
    let filters=[],range=[0,999],single=false,write=null;
    const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},neq(k,v){filters.push(r=>r[k]!==v);return q;},
      in(k,v){filters.push(r=>v.includes(r[k]));return q;},order(){return q;},limit(n){range=[0,n-1];return q;},range(a,b){range=[a,b];return q;},
      ilike(k,v){filters.push(r=>String(r[k]||'').toLowerCase().includes(v.replace(/%/g,'').toLowerCase()));return q;},
      single(){single=true;return q;},maybeSingle(){single=true;return q;},insert(row){write={kind:'insert',row};return q;},update(row){write={kind:'update',row};return q;},
      then(resolve,reject){return Promise.resolve().then(()=>{
        state.calls.push({table,write});
        if(table==='product_workflow_briefs' && window.__pwMissing) return {data:null,error:{message:'Could not find the table product_workflow_briefs in the schema cache'}};
        if(write && table==='product_tracker' && state.failPipeline) return {data:null,error:{message:'simulated Pipeline failure'}};
        const rows=tables[table]||(tables[table]=[]);
        if(write?.kind==='insert') rows.push(...(Array.isArray(write.row)?write.row:[write.row]).map(r=>({id:crypto.randomUUID(),...r})));
        if(write?.kind==='update') rows.filter(r=>filters.every(f=>f(r))).forEach(r=>Object.assign(r,write.row));
        const data=rows.filter(r=>filters.every(f=>f(r))).slice(range[0],range[1]+1);
        return {data:structuredClone(single?data[0]||null:data),error:null};
      }).then(resolve,reject);},
    };return q;
  }
  window.supabase={createClient(){return {from,auth:{async getSession(){return {data:{session:{user:{id:'U1',email:'test@example.test'}}},error:null};},onAuthStateChange(){return {data:{subscription:{unsubscribe(){}}}};}},
    async rpc(name,args){
      state.calls.push({name,args:structuredClone(args)});
      if(name==='po_builder_can_write')return {data:state.canWrite,error:null};
      if(name==='save_product_workflow_brief'){
        let b=tables.product_workflow_briefs.find(x=>x.id===args.p_id);
        if(!b){b={id:args.p_id,version:0,company_entity_id:args.p_company,source_kind:args.p_kind,source_id:args.p_source_id,source_snapshot:tables.product_concepts.find(x=>x.id===args.p_source_id)||tables.products_master.find(x=>x.id===args.p_source_id)||{}};tables.product_workflow_briefs.push(b);}
        if(b.version===args.p_version){b.content=structuredClone(args.p_content);b.status=args.p_status;b.version++;}
        if(state.failSave){state.failSave=false;return {data:null,error:{message:'Response lost. Retry save.'}};}
        return {data:structuredClone(b),error:null};
      }
      if(name==='handoff_product_workflow_brief'){
        const b=tables.product_workflow_briefs.find(x=>x.id===args.p_id);
        if(args.p_target==='po'&&!b.po_header_id){b.po_header_id='PO1';tables.po_headers.push({id:'PO1',company_entity_id:'C1',po_name:'TEST-1',is_new_product_po:true,factory_id:'F1'});tables.po_lines.push(...b.content.lines.map((l,i)=>({id:'LINE'+i,company_entity_id:'C1',po_header_id:'PO1',title_snapshot:b.content.title,qty:l.qty})));b.version++;}
        if(args.p_target==='launch'&&!b.launch_id){b.launch_id='LAUNCH1';b.version++;}
        return {data:structuredClone(b),error:null};
      }
      if(name==='product_workflow_restock_basis')return {data:{product_id:'P1',sku:'TEE-M',units_90d:900,on_hand:100,incoming_units:50,lookback_days:90,horizon_days:args.p_horizon,window_start:'2026-06-28',window_end:'2026-09-25',incoming_cutoff:'2026-12-25',sales_names:1,stock_as_of:new Date().toISOString(),observed_at:new Date().toISOString()},error:null};
      return {data:null,error:null};
    }};}};
})();
