/* Date browsing is independent of the import batch used for approval/posting. */
(function () {
  'use strict';
  const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  function preset(name, now = new Date()) {
    const y=now.getFullYear(), m=now.getMonth();
    if(name==='last') return {start:iso(new Date(y,m-1,1)),end:iso(new Date(y,m,0))};
    if(name==='quarter') return {start:iso(new Date(y,Math.floor(m/3)*3,1)),end:iso(now)};
    if(name==='year') return {start:iso(new Date(y,0,1)),end:iso(now)};
    return {start:iso(new Date(y,m,1)),end:iso(new Date(y,m+1,0))};
  }
  function valid({start,end}) {
    const date = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s;
    return date(start) && date(end) && start<=end;
  }
  // Preserve every coding field when editing across imports; fetch the raw payload only on demand.
  const LIST_FIELDS='id,batch_id,txn_date,description,amount,status,coding_source,confidence,coding_conflict,clean_merchant,card_name,qbo_account_name,qbo_location_name,entity_name,cardholder,cardholder_email,vendor_name,memo,exclude_reason,origin,provider_status,provider_updated_at,currency,qbo_account_id,accounting_treatment,qbo_location_id,entity_qbo_id,entity_type,rule_id,ai_reasoning,row_no,last4,external_transaction_id';
  async function read(db, company, source, batches, range) {
    if(!company || !source || !valid(range)) throw new Error('Choose an account and valid dates.');
    // Batch membership, not a guessed source column on transactions, scopes CSV and bank rows alike.
    const ids=batches.filter(b=>b.company_entity_id===company && b.source_id===source && b.status!=='voided').map(b=>b.id);
    const rows=[];
    for(let i=0;i<ids.length;i+=50) {
      for(let offset=0;;offset+=500) {
        const {data,error}=await db.from('card_transactions').select(LIST_FIELDS).eq('company_entity_id',company)
          .in('batch_id',ids.slice(i,i+50)).gte('txn_date',range.start).lte('txn_date',range.end)
          .order('txn_date',{ascending:false}).order('id').range(offset,offset+499);
        if(error) throw new Error(error.message);
        rows.push(...(data || [])); if(!data || data.length<500) break;
      }
    }
    return rows.sort((a,b)=>String(b.txn_date).localeCompare(String(a.txn_date)) || String(a.id).localeCompare(String(b.id)));
  }
  function summary(rows) {
    return {out:rows.reduce((n,t)=>n+Math.max(0,Number(t.amount)||0),0),in:rows.reduce((n,t)=>n+Math.max(0,-Number(t.amount)||0),0),
      count:rows.length,uncoded:rows.filter(t=>t.status==='uncoded').length,coded:rows.filter(t=>t.status==='coded').length,
      rules:rows.filter(t=>t.coding_source==='rule').length};
  }
  function preferences(storage) {
    const key=(company,source)=>'silo:transaction-dates:'+company+':'+source;
    return {
      get(company,source) {try {const value=JSON.parse(storage?.getItem(key(company,source)) || 'null');return valid(value || {})?value:null;}catch{return null;}},
      set(company,source,range) {if(!company || !source || !valid(range))return;try{storage?.setItem(key(company,source),JSON.stringify(range));storage?.setItem('silo:transaction-account:'+company,source);}catch{}},
      account(company) {try{return storage?.getItem('silo:transaction-account:'+company) || null;}catch{return null;}}
    };
  }
  // Same representation in the light date list and the full review row.
  function fingerprint(t) {
    return JSON.stringify(['id','batch_id','txn_date','description','amount','status','clean_merchant','card_name','origin','provider_status','provider_updated_at','currency','qbo_account_id','accounting_treatment','coding_source'].map(k=>t[k]??null));
  }
  // Derive routine treatment from an explicit category choice, never from a merchant guess.
  function inferTreatment(t,type,sourceType) {
    if(t.origin!=='plaid')return t.accounting_treatment;
    if(!t.qbo_account_id)return 'unknown';
    if(['Other Current Asset','Other Current Liability'].includes(type))
      return ['transfer','payroll_settlement','shopify_settlement'].includes(t.accounting_treatment)?t.accounting_treatment:'transfer';
    if(['Credit Card','Accounts Payable'].includes(type))return sourceType==='bank'?'card_payment':'unknown';
    if(['Expense','Other Expense','Cost of Goods Sold','Fixed Asset','Other Asset'].includes(type))return Number(t.amount)>0?'purchase':Number(t.amount)<0?'refund':'unknown';
    if(['Income','Other Income','Accounts Receivable'].includes(type) && Number(t.amount)<0)return 'deposit';
    return 'unknown';
  }
  // Resolve only a real account in the source connection, including older name-only responses.
  function suggestionAccount(t,s,accounts) {
    const matches=accounts.filter(a=>s.account_id ? a.id===s.account_id && a.name===s.account_name : a.name===s.account_name);
    if(matches.length!==1)return null;
    const treatment=s.accounting_treatment || (Number(t.amount)>0?'purchase':'refund');
    if((treatment==='purchase' && Number(t.amount)<=0) || (['refund','deposit'].includes(treatment) && Number(t.amount)>=0))return null;
    const types={purchase:['Expense','Other Expense','Cost of Goods Sold','Fixed Asset','Other Asset','Other Current Asset'],
      refund:['Expense','Other Expense','Cost of Goods Sold','Fixed Asset','Other Asset','Other Current Asset'],
      deposit:['Income','Other Income'],transfer:['Other Current Asset','Other Current Liability'],
      payroll_settlement:['Other Current Asset','Other Current Liability'],shopify_settlement:['Other Current Asset','Other Current Liability'],
      card_payment:['Credit Card','Accounts Payable']};
    return (types[treatment] || []).includes(matches[0].type)?matches[0]:null;
  }
  window.SiloTransactionDates={suggestionAccount,inferTreatment,preset,valid,read,summary,preferences,fingerprint};
})();
