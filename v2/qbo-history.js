/* Immutable report history. Never a journal-composer or posting input. */
(function () {
  'use strict';
  const el=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const amount=value=>value==null?'—':Number(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const issues={no_ledger_rows:'Account section has no retained lines',running_balance_gap:'Running balance does not follow the prior line',missing_transaction_reference:'A source transaction ID is missing',movement_total_mismatch:'Period movement does not tie to QBO’s total',missing_trial_balance_account:'Account missing from trial balance',trial_balance_mismatch:'Closing balance differs from trial balance',missing_ledger_account:'Trial balance account missing from ledger detail'};
  const result=async query=>{const r=await query;if(r.error)throw new Error(r.error.message);return r.data;};
  const table=(heads,rows)=>'<div class="books-table-scroll"><table><thead><tr>'+heads.map(h=>`<th>${esc(h)}</th>`).join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';
  function windowDates(start,end,cutover){
    const date=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
    if(!date(start)||!date(end)||!date(cutover)||start>end||end>=cutover||((Date.parse(end)-Date.parse(start))/86400000)>365)throw new Error('Choose a window of at most 366 days ending before your Silo start date');
    return {start_date:start,end_date:end};
  }
  async function mount({db,companyId}){
    let settings,archives=[],selected=null,offset=0,busy=false,wired=false,ready=false;
    const status=(message,error=false)=>{el('historyStatus').textContent=message;el('historyStatus').className='bcn-status'+(error?' bcn-status--neg':'');};
    async function work(fn){if(busy)return;busy=true;el('historyInputs').disabled=true;for(const id of ['historyArchive','historyAccount','historyMore','historyRefresh'])el(id).disabled=true;
      try{await fn();}catch(e){status(`${e.message}. Your saved history is unchanged. Check the period and QBO connection, then retry or ask your administrator for help.`,true);}
      finally{busy=false;el('historyInputs').disabled=!settings||!ready;for(const id of ['historyArchive','historyAccount','historyMore','historyRefresh'])el(id).disabled=false;}}
    async function lines(reset=false){if(reset){offset=0;el('historyRows').innerHTML='';}if(!selected)return;
      let query=db.from('qbo_history_lines').select('row_no,row_kind,qbo_account_id,account_name,transaction_date,qbo_transaction_id,transaction_type,document_number,counterparty,memo,split_account_id,split_account_name,natural_amount,natural_balance').eq('company_entity_id',companyId).eq('import_id',selected.id);
      if(el('historyAccount').value)query=query.eq('qbo_account_id',el('historyAccount').value);
      const rows=await result(query.order('row_no').range(offset,offset+99));
      if(!offset&&!rows.length)el('historyRows').textContent='No lines for this account. Choose another account or review the reconciliation exceptions below.';
      if(rows.length)el('historyRows').insertAdjacentHTML('beforeend',table(['Date / type','Account / counterparty','Description / reference','Amount','Running balance'],rows.map(r=>`<tr><td>${esc(r.transaction_date||'Beginning balance')}<small>${esc(r.transaction_type)}</small></td><td>${esc(r.account_name)}<small>${esc(r.counterparty)}</small></td><td>${esc(r.memo||r.document_number||'—')}<details><summary>Source details</summary><small>QBO transaction: ${esc(r.qbo_transaction_id||'Not supplied')}<br>Number: ${esc(r.document_number||'Not supplied')}<br>Split: ${esc(r.split_account_name||'Not supplied')} ${r.split_account_id?'('+esc(r.split_account_id)+')':''}</small></details></td><td class="num">${r.row_kind==='opening'?'—':amount(r.natural_amount)}</td><td class="num">${amount(r.natural_balance)}</td></tr>`)));
      offset+=rows.length;el('historyMore').hidden=rows.length<100;
    }
    async function show(){
      selected=archives.find(a=>a.id===el('historyArchive').value)||null;
      el('historyDetail').hidden=!selected;el('historyChecks').hidden=!selected;
      if(!selected){el('historySummary').textContent='No snapshots saved yet. Choose a historical window and save QBO history.';return;}
      const a=selected;
      el('historySummary').innerHTML=`<p><strong>${esc(a.period_start)} → ${esc(a.period_end)}</strong></p><p>${esc(a.currency)} · ${esc(a.accounting_basis)} · ${a.transaction_count} transaction lines</p><p>${a.exception_count?`${a.exception_count} account exceptions to review`:'Account balances matched'} · saved ${esc(a.created_at)}</p>`;
      el('historyAccount').innerHTML='<option value="">All accounts</option>'+a.reconciliation.map(r=>`<option value="${esc(r.qbo_account_id)}">${esc(r.account_name)}</option>`).join('');
      el('historyReconciliation').innerHTML=table(['Account','Ledger closing','Trial balance','Difference','Check'],a.reconciliation.map(r=>`<tr><td>${esc(r.account_name)}</td><td class="num">${amount(r.ledger_debit_net)}</td><td class="num">${amount(r.trial_balance_debit_net)}</td><td class="num">${amount(r.difference)}</td><td>${r.issues.length?r.issues.map(i=>esc(issues[i]||i)).join('<br>'):'Matched'}</td></tr>`));
      await lines(true);status(a.exception_count?'History saved with exceptions. Review account reconciliation below; this window is not yet reconciled.':'Saved history is available in Silo. Select an account to inspect its lines.');
    }
    async function refresh(prefer){
      settings=await result(db.from('accounting_settings').select('qbo_connection_id,accounting_start_date,accounting_basis,base_currency,fiscal_year_start_month').eq('company_entity_id',companyId).maybeSingle());
      // Paginate archives without downloading their raw report copies.
      archives=[];for(let page=0;;page+=100){const rows=await result(db.from('qbo_history_imports').select('id,period_start,period_end,currency,accounting_basis,created_at,exception_count,transaction_count,reconciliation').eq('company_entity_id',companyId).order('created_at',{ascending:false}).order('id').range(page,page+99));archives.push(...rows);if(rows.length<100)break;}
      ready=true;
      el('historyArchive').innerHTML=archives.length?archives.map(a=>`<option value="${esc(a.id)}">${esc(a.period_start)} – ${esc(a.period_end)} · ${a.exception_count?'Exceptions':'Matched'} · ${esc(a.created_at)}</option>`).join(''):'<option value="">No saved history</option>';
      if(prefer&&archives.some(a=>a.id===prefer))el('historyArchive').value=prefer;
      el('historyConnection').textContent=settings?`Uses your QBO company selected in Setup · ${settings.base_currency} · ${settings.accounting_basis}. Silo starts ${settings.accounting_start_date}.`:'Prepare your opening balances in Setup before importing history.';
      if(settings&&!el('historyTo').value){const end=new Date(settings.accounting_start_date+'T00:00:00Z');end.setUTCDate(end.getUTCDate()-1);el('historyTo').value=end.toISOString().slice(0,10);el('historyFrom').value=el('historyTo').value.slice(0,7)+'-01';}
      await show();
    }
    // Wire before first load so a missing migration can be retried in place.
    if(!wired){wired=true;
      el('historyRefresh').addEventListener('click',()=>work(()=>refresh(selected?.id)));
      el('historyArchive').addEventListener('change',()=>work(show));el('historyAccount').addEventListener('change',()=>work(()=>lines(true)));el('historyMore').addEventListener('click',()=>work(()=>lines()));
      el('historyForm').addEventListener('submit',e=>{e.preventDefault();work(async()=>{
        // Re-read settings: another reviewer may have changed a draft cutover.
        settings=await result(db.from('accounting_settings').select('*').eq('company_entity_id',companyId).maybeSingle());
        if(!settings)throw new Error('Prepare opening balances in Setup first');
        const dates=windowDates(el('historyFrom').value,el('historyTo').value,settings.accounting_start_date);
        const params={...dates,accounting_method:settings.accounting_basis};
        status('Reading your general ledger from QuickBooks…');
        const gl=await result(db.functions.invoke('quickbooks-report',{body:{connection_id:settings.qbo_connection_id,report_name:'GeneralLedger',params}}));
        if(!gl?.run_id)throw new Error(gl?.error||'QBO did not save the general ledger report');
        status('Reading the same-date trial balance for reconciliation…');
        const fiscal=settings.fiscal_year_start_month;const year=Number(dates.end_date.slice(0,4))-(Number(dates.end_date.slice(5,7))<fiscal?1:0);
        const tb=await result(db.functions.invoke('quickbooks-report',{body:{connection_id:settings.qbo_connection_id,report_name:'TrialBalance',params:{...params,start_date:`${year}-${String(fiscal).padStart(2,'0')}-01`}}}));
        if(!tb?.run_id)throw new Error(tb?.error||'QBO did not save the trial balance report');
        status('Saving immutable history and checking account balances…');
        const saved=await result(db.rpc('archive_qbo_ledger',{p_gl_run_id:gl.run_id,p_tb_run_id:tb.run_id}));
        if(!saved?.id)throw new Error('No archive ID was returned; refresh saved history before retrying');
        await refresh(saved.id);
      });});
    }
    await work(()=>refresh());
  }
  window.SiloQboHistory={mount};
})();
