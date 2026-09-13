/* Cash movement model. Provider amounts are positive out / negative in.
   Accounting approval/status never gates a posted bank movement. */
(function () {
  'use strict';
  const DAY=86400000;
  const date=s=>new Date(s+'T00:00:00Z');
  const iso=d=>d.toISOString().slice(0,10);
  const addDays=(s,n)=>{const d=date(s);d.setUTCDate(d.getUTCDate()+n);return iso(d);};
  const days=(a,b)=>Math.round((date(b)-date(a))/DAY)+1;
  const validDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'') && !isNaN(date(s)) && iso(date(s))===s;
  function addMonths(s,n) {
    const d=date(s),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+n);
    const end=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
    d.setUTCDate(Math.min(day,end));return iso(d);
  }
  const cents=v=>v==null || v==='' || !Number.isFinite(Number(v))?null:Math.round(Number(v)*100);
  function columns(start,end,unit,kind) {
    const out=[];let cursor=start;
    while(cursor<=end){
      const d=date(cursor);let next;
      if(unit==='day')next=cursor;
      else if(unit==='week')next=addDays(cursor,(7-d.getUTCDay())%7);
      else next=iso(new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)));
      const stop=next<end?next:end;out.push({start:cursor,end:stop,kind,days:days(cursor,stop)});cursor=addDays(stop,1);
    }
    return out;
  }
  function occurrences(item,start,end) {
    if(!validDate(item.start_date) || !validDate(start) || !validDate(end))return [];
    const limit=item.end_date && item.end_date<end?item.end_date:end;
    if(item.kind==='one_time')return item.start_date>=start && item.start_date<=limit?[item.start_date]:[];
    const step={monthly:1,quarterly:3,annual:12}[item.cadence];
    const dayStep={weekly:7,biweekly:14}[item.cadence];
    if(!step && !dayStep)return [];
    let n=dayStep?Math.max(0,Math.floor((date(start)-date(item.start_date))/DAY/dayStep)-1)
      :Math.max(0,Math.floor(((date(start).getUTCFullYear()-date(item.start_date).getUTCFullYear())*12+date(start).getUTCMonth()-date(item.start_date).getUTCMonth())/step)-1);
    const out=[];
    for(let count=0;count<1000;count++,n++){
      const d=step?addMonths(item.start_date,n*step):addDays(item.start_date,n*dayStep);
      if(d>limit)break;if(d>=start)out.push(d);
    }
    return out;
  }
  function flowFor(type,treatment) {
    if(treatment==='transfer' || type==='Bank')return 'Transfers';
    if(['Fixed Asset','Other Asset'].includes(type))return 'Investing';
    if(['Credit Card','Long Term Liability','Equity'].includes(type) || treatment==='card_payment')return 'Financing';
    return 'Operating';
  }
  const coaKey=(connection,id)=>'coa|'+encodeURIComponent(connection||'')+'|'+encodeURIComponent(id);
  function catalog(accounts) {
    return new Map(accounts.map(a=>[coaKey(a.connection_id,a.qbo_account_id),{key:coaKey(a.connection_id,a.qbo_account_id),name:a.fully_qualified_name||a.name,type:a.account_type,flow:flowFor(a.account_type)}]));
  }
  function build({today,lookback=90,horizon=3,unit='week',group='coa',currency='USD',selected='all',accounts=[],sources=[],transactions=[],chart=[],plans=[],baseCurrency='USD',trend=true}) {
    if(!validDate(today) || ![30,90].includes(lookback) || ![3,6].includes(horizon) || !['day','week','month'].includes(unit) || !['coa','cashflow'].includes(group))throw new Error('Invalid cashflow date settings.');
    const historyStart=addDays(today,1-lookback),futureStart=addDays(today,1),futureEnd=addMonths(today,horizon);
    const cols=[...columns(historyStart,today,unit,'actual'),...columns(futureStart,futureEnd,unit,'forecast')];
    const cash=accounts.filter(a=>a.type==='depository' && a.iso_currency_code===currency && a.connection_status!=='disconnected' && (selected==='all'||a.id===selected));
    const selectedIds=new Set(cash.map(a=>a.id));const sourceMap=new Map(sources.map(s=>[s.id,s]));const accountMap=new Map(cash.map(a=>[a.id,a]));const coa=catalog(chart);
    const bucket=t=>{
      if(t.status==='excluded')return {key:'excluded',name:'Excluded from coding',flow:'Uncategorized'};
      if(!t.qbo_account_id)return {key:'uncategorized',name:'Uncategorized',flow:'Uncategorized'};
      const connection=sourceMap.get(accountMap.get(t.plaid_account_id)?.source_id)?.qbo_connection_id;
      const key=coaKey(connection,t.qbo_account_id),entry=coa.get(key);
      return {key,name:entry?.name||t.qbo_account_name||'Category unavailable',flow:flowFor(entry?.type,t.accounting_treatment)};
    };
    const rows=new Map();
    function row(direction,category){const key=direction+'|'+(group==='cashflow'?category.flow:category.key);
      if(!rows.has(key))rows.set(key,{key,direction,label:group==='cashflow'?category.flow:category.name,actual:Array(cols.length).fill(0),forecast:Array(cols.length).fill(0),planned:Array(cols.length).fill(0),trend:Array(cols.length).fill(0),transactions:Array.from({length:cols.length},()=>[])});
      return rows.get(key);
    }
    const series=new Map(),coverage=new Map(),seen=new Set();let pending=0,uncategorized=0,excluded=0;
    const posted=[];
    for(const t of transactions){
      if(t.origin!=='plaid' || !selectedIds.has(t.plaid_account_id) || t.currency!==currency || !validDate(t.txn_date))continue;
      if(t.provider_status==='pending'){pending++;continue;}
      if(t.provider_status!=='posted' || t.txn_date<historyStart || t.txn_date>today)continue;
      const identity=t.plaid_account_id+'|'+(t.external_transaction_id||t.id);if(seen.has(identity))continue;seen.add(identity);
      const amount=cents(t.amount);if(amount==null)throw new Error('A bank transaction has an invalid amount.');
      const movement=-amount,category=bucket(t),direction=movement>=0?'in':'out';
      const r=row(direction,category),i=cols.findIndex(c=>c.kind==='actual'&&t.txn_date>=c.start&&t.txn_date<=c.end);
      if(i>=0){r.actual[i]+=movement;r.transactions[i].push({...t,movement,category:category.name});}
      posted.push({...t,movement});if(!t.qbo_account_id)uncategorized++;if(t.status==='excluded')excluded++;
      // Today's partial activity is displayed, but only completed days train the trend.
      if(t.txn_date<today){const earliest=coverage.get(t.plaid_account_id);if(!earliest || t.txn_date<earliest)coverage.set(t.plaid_account_id,t.txn_date);}
      if(t.txn_date>=today || category.flow==='Transfers' || t.accounting_treatment==='transfer')continue;
      const seriesKey=t.plaid_account_id+'|'+direction+'|'+category.key;
      if(!series.has(seriesKey))series.set(seriesKey,{account:t.plaid_account_id,direction,category,total:0});
      series.get(seriesKey).total+=movement;
    }
    const companyPlans=selected==='all'&&currency===baseCurrency;
    const planItems=companyPlans?plans.filter(p=>p.is_active!==false):[];
    const resolvedPlans=planItems.map(p=>{
      const category=coa.get(p.category)|| (p.category==='uncategorized'?{key:'uncategorized',name:'Uncategorized',flow:'Uncategorized'}:p.category?.startsWith('flow|')?{key:p.category,name:p.category.slice(5),flow:p.category.slice(5)}:{key:'plan|'+(p.category||p.label),name:p.category?.startsWith('coa|')?'Saved COA bucket':p.category||p.label,flow:'Planning'});
      return {...p,categoryInfo:category,movement:cents(p.amount),dates:occurrences(p,futureStart,futureEnd)};
    });
    const trendDays=days(futureStart,futureEnd);
    for(const s of series.values()){
      const denominator=days(coverage.get(s.account),addDays(today,-1));
      let previous=0;
      const r=row(s.direction,s.category);
      for(let n=1;n<=trendDays;n++){
        const d=addDays(futureStart,n-1),cumulative=Math.round(s.total*n/denominator),amount=cumulative-previous;previous=cumulative;
        const replaced=resolvedPlans.some(p=>p.kind==='recurring' && p.movement!=null && (p.movement>=0?'in':'out')===s.direction && (p.category===s.category.key || p.category==='flow|'+s.category.flow) && p.start_date<=d && (!p.end_date || p.end_date>=d));
        if(!trend || replaced)continue;
        const i=cols.findIndex(c=>c.kind==='forecast'&&d>=c.start&&d<=c.end);r.trend[i]+=amount;r.forecast[i]+=amount;
      }
    }
    for(const p of resolvedPlans){
      if(p.movement==null || !p.movement)throw new Error('A planning item has an invalid amount.');
      const r=row(p.movement>=0?'in':'out',p.categoryInfo);
      for(const d of p.dates){const i=cols.findIndex(c=>c.kind==='forecast'&&d>=c.start&&d<=c.end);if(i>=0){r.planned[i]+=p.movement;r.forecast[i]+=p.movement;}}
    }
    const balances=cash.map(a=>cents(a.current_balance));
    const currentCash=cash.length && balances.every(n=>n!==null)?balances.reduce((a,b)=>a+b,0):null;
    const inflow=cols.map((c,i)=>[...rows.values()].filter(r=>r.direction==='in').reduce((v,r)=>v+(c.kind==='actual'?r.actual[i]:r.forecast[i]),0));
    const outflow=cols.map((c,i)=>[...rows.values()].filter(r=>r.direction==='out').reduce((v,r)=>v+(c.kind==='actual'?r.actual[i]:r.forecast[i]),0));
    const net=cols.map((c,i)=>inflow[i]+outflow[i]);let running=currentCash;
    const ending=cols.map((c,i)=>{if(c.kind==='actual')return null;running=running===null?null:running+net[i];return running;});
    // Low is computed by day, independent of displayed aggregation (a monthly net can hide a mid-month gap).
    let dailyBalance=currentCash,low=currentCash,lowDate=today;
    for(let n=0;n<trendDays;n++){
      const d=addDays(futureStart,n);let movement=0;
      for(const s of series.values()){
        const denom=days(coverage.get(s.account),addDays(today,-1));
        const replaced=resolvedPlans.some(p=>p.kind==='recurring' && (p.movement>=0?'in':'out')===s.direction && (p.category===s.category.key || p.category==='flow|'+s.category.flow) && p.start_date<=d && (!p.end_date||p.end_date>=d));
        if(trend&&!replaced)movement+=Math.round(s.total*(n+1)/denom)-Math.round(s.total*n/denom);
      }
      for(const p of resolvedPlans)if(p.dates.includes(d))movement+=p.movement;
      dailyBalance=dailyBalance===null?null:dailyBalance+movement;if(dailyBalance!==null && dailyBalance<low){low=dailyBalance;lowDate=d;}
    }
    return {cols,rows:[...rows.values()].sort((a,b)=>a.direction.localeCompare(b.direction)||a.label.localeCompare(b.label)),cash,currentCash,inflow,outflow,net,ending,low,lowDate,coverage:[...coverage].map(([id,start])=>({id,start,days:days(start,addDays(today,-1))})),pending,uncategorized,excluded,postedCount:posted.length,companyPlans,historyStart,futureStart,futureEnd};
  }
  window.SiloCashflow={build,columns,occurrences,addDays,addMonths,validDate,cents,coaKey,catalog};
})();
