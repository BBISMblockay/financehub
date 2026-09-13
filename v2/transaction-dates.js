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
  // List-only fields include search/filter inputs; raw payload and editing metadata load on review.
  const LIST_FIELDS='id,batch_id,txn_date,description,amount,status,coding_source,confidence,coding_conflict,clean_merchant,card_name,qbo_account_name,qbo_location_name,entity_name,cardholder,cardholder_email,vendor_name,memo,exclude_reason';
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
  window.SiloTransactionDates={preset,valid,read,summary};
})();
