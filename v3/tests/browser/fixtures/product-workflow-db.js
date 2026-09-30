// Offline fixture for the real preview page. No network/auth credentials.
(function () {
  const tables = {
    profiles:[{id:'U1',role:'owner',email:'test@example.test'}],
    factories:[{id:'F1',company_entity_id:'C1',factory_name:'Test factory'}],
    product_concepts:[{id:'CPT1',company_entity_id:'C1',title:'Practice tee',status:'draft',concept_summary:'Wear it every day',suggested_factory_id:'F1',suggested_size_breakdown:{S:40,M:60},suggested_marketing_copy:'Unapproved copy',audience:'Players',marketing_angle:'Everyday baseball',suggested_launch_date:'2026-11-01'}],
    products_master:[{id:'P1',company_entity_id:'C1',product_title:'Catalog tee',sku:'TEE-M',variant_title:'M',lead_time_days:30,target_stock_days:60}],
    product_workflow_briefs:[],po_headers:[],po_lines:[],product_tracker:[],launch_product_readiness:[],entity_memberships:[],
  };
  tables.products_master.push({id:'P2',company_entity_id:'C1',product_title:'Catalog tee',sku:'TEE-S',variant_title:'S',lead_time_days:30,target_stock_days:60});
  const group={shop_domain:'test.myshopify.com',shopify_product_id:'123'};
  const catalog=()=>({...tables.products_master[0],catalog_group:group,variants:structuredClone(tables.products_master)});
  const basis=args=>tables.products_master.map((p,i)=>({product_id:p.id,sku:p.sku,units_90d:i?90:900,on_hand:i?1000:100,incoming_units:i?0:50,lookback_days:90,horizon_days:args.p_horizon,window_start:'2026-06-28',window_end:'2026-09-25',incoming_cutoff:'2026-12-25',sales_names:1,stock_as_of:new Date().toISOString(),observed_at:new Date().toISOString()}));
  tables.product_concepts.push({id:'FOREIGN',company_entity_id:'C2',title:'Other company concept',status:'draft'});
  const state=window.__pw={tables,calls:[],canWrite:!window.__pwViewer,failSave:false,failPipeline:false};
  // Stand-in for product_studio_concepts_v: the stage is derived, never stored.
  function stages(){
    return tables.product_concepts.filter(c=>c.company_entity_id==='C1'&&c.status!=='archived').map(c=>{
      const briefs=tables.product_workflow_briefs.filter(b=>b.source_kind==='concept'&&b.source_id===c.id);
      const po=briefs.find(b=>b.po_header_id), ready=briefs.find(b=>b.po_ready_at&&!b.po_header_id);
      return {...c,child_count:0,po_header_id:po?.po_header_id||null,po_name:po?'TEST-1':null,po_status:po?'Draft':null,ready_brief_id:ready?.id||null,ready_stale:!!(ready&&c.__stale),
        latest_brief_status:briefs[0]?.status||null,stage:po?'po_created':ready&&!c.__stale?'ready_for_po':'draft'};
    });
  }
  function from(table) {
    let filters=[],range=[0,999],single=false,write=null;
    const value=(r,k)=>k==='content->>catalog_scope'?r.content?.catalog_scope:k==='content->catalog_group'?JSON.stringify(r.content?.catalog_group):r[k];
    const q={select(){return q;},eq(k,v){filters.push(r=>value(r,k)===v);return q;},is(k,v){filters.push(r=>value(r,k)===v);return q;},neq(k,v){filters.push(r=>r[k]!==v);return q;},
      in(k,v){filters.push(r=>v.includes(r[k]));return q;},order(){return q;},limit(n){range=[0,n-1];return q;},range(a,b){range=[a,b];return q;},
      ilike(k,v){filters.push(r=>String(r[k]||'').toLowerCase().includes(v.replace(/%/g,'').toLowerCase()));return q;},
      single(){single=true;return q;},maybeSingle(){single=true;return q;},insert(row){write={kind:'insert',row};return q;},update(row){write={kind:'update',row};return q;},
      then(resolve,reject){return Promise.resolve().then(()=>{
        state.calls.push({table,write});
        if(table==='product_workflow_briefs' && window.__pwMissing) return {data:null,error:{message:'Could not find the table product_workflow_briefs in the schema cache'}};
        if(write && table==='product_tracker' && state.failPipeline) return {data:null,error:{message:'simulated Pipeline failure'}};
        const rows=table==='product_studio_concepts_v'?stages():(tables[table]||(tables[table]=[]));
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
      if(name==='product_workflow_catalog_search')return {data:[{...tables.products_master[0],catalog_group:group,variant_count:2}],error:null};
      if(name==='product_workflow_catalog_source')return {data:catalog(),error:null};
      if(name==='product_workflow_product_basis')return {data:basis(args),error:null};
      if(name==='save_product_workflow_brief'){
        let b=tables.product_workflow_briefs.find(x=>x.id===args.p_id);
        if(!b){b={id:args.p_id,version:0,company_entity_id:args.p_company,source_kind:args.p_kind,source_id:args.p_source_id,source_snapshot:tables.product_concepts.find(x=>x.id===args.p_source_id)||(args.p_content.catalog_scope==='product'?catalog():tables.products_master.find(x=>x.id===args.p_source_id))||{}};tables.product_workflow_briefs.push(b);}
        // The database re-checks Ready for PO; this stand-in refuses the two
        // things the page must never send for a concept: no confirmation, no type.
        if(args.p_kind==='concept'&&args.p_status==='reviewed'&&(!args.p_content.po_readiness?.range_confirmed||!args.p_content.product_type)){
          if(b.version===0) tables.product_workflow_briefs.splice(tables.product_workflow_briefs.indexOf(b),1);
          return {data:null,error:{message:'Not ready for PO: Confirm the size/variant range and quantities'}};
        }
        if(b.version===args.p_version){b.content=structuredClone(args.p_content);b.status=args.p_status;b.version++;
          b.po_ready_at=args.p_kind==='concept'&&args.p_status==='reviewed'?new Date().toISOString():null;}
        if(state.failSave){state.failSave=false;return {data:null,error:{message:'Response lost. Retry save.'}};}
        return {data:structuredClone(b),error:null};
      }
      if(name==='handoff_product_workflow_brief'){
        const b=tables.product_workflow_briefs.find(x=>x.id===args.p_id);
        if(args.p_target==='po'&&b.source_kind==='concept'&&!b.po_header_id&&!b.po_ready_at) return {data:null,error:{message:'Mark this concept ready for PO before creating a PO'}};
        if(args.p_target==='po'&&!b.po_header_id){b.po_header_id='PO1';tables.po_headers.push({id:'PO1',company_entity_id:'C1',po_name:'TEST-1',is_new_product_po:true,factory_id:'F1'});tables.po_lines.push(...b.content.lines.filter(l=>l.qty>0).map((l,i)=>({id:'LINE'+i,company_entity_id:'C1',po_header_id:'PO1',title_snapshot:b.content.title,product_master_id:l.product_master_id,qty:l.qty})));b.version++;}
        if(args.p_target==='launch'&&!b.launch_id){b.launch_id='LAUNCH1';b.version++;}
        return {data:structuredClone(b),error:null};
      }
      if(name==='product_workflow_restock_basis')return {data:{product_id:'P1',sku:'TEE-M',units_90d:900,on_hand:100,incoming_units:50,lookback_days:90,horizon_days:args.p_horizon,window_start:'2026-06-28',window_end:'2026-09-25',incoming_cutoff:'2026-12-25',sales_names:1,stock_as_of:new Date().toISOString(),observed_at:new Date().toISOString()},error:null};
      return {data:null,error:null};
    }};}};
})();
