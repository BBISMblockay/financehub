/* Immutable report history. Never a journal-composer or posting input. */
(function () {
  'use strict';
  const el=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // A saved window's short name. '2025-01-01 – 2025-12-31 · 2026-09-15T06:31:29Z'
  // in a dropdown is three facts wide and one of them is a machine timestamp.
  // Rounding is only allowed where it claims nothing the dates do not say: a
  // window ending mid-month is not a month, so it keeps its dates in full.
  function windowLabel(start,end){
   const s=/^(\d{4})-(\d{2})-(\d{2})$/.exec(start||''),e=/^(\d{4})-(\d{2})-(\d{2})$/.exec(end||'');
   if(!s||!e)return `${start||'?'} → ${end||'?'}`;
   const [sy,sm,sd]=s.slice(1).map(Number),[ey,em,ed]=e.slice(1).map(Number);
   if(sm<1||sm>12||em<1||em>12)return `${start} → ${end}`;
   if(sd!==1||ed!==new Date(Date.UTC(ey,em,0)).getUTCDate())return `${start} → ${end}`;
   if(sy===ey&&sm===1&&em===12)return String(sy);
   if(sy===ey&&sm===em)return `${MONTHS[sm-1]} ${sy}`;
   if(sy===ey)return `${MONTHS[sm-1]} – ${MONTHS[em-1]} ${sy}`;
   return `${MONTHS[sm-1]} ${sy} – ${MONTHS[em-1]} ${ey}`;
  }
  // The timestamp a row was saved at, to the day. Nobody reads the seconds.
  const savedOn=value=>String(value??'').slice(0,10);
  const amount=value=>value==null?'—':Number(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  /* What each reconciliation issue MEANS, and what it asks of a person.
     The archive counts a trial-balance account with no ledger lines as an
     exception even when its balance is zero, on purpose -- a zero closing
     balance in THIS window does not prove the account had no activity in
     another one. That stance is right and stays. What it produced on the
     first real import was a screen reading "71 account exceptions to review
     -- this window is not yet reconciled", over 71 rows of two em-dashes and
     a 0.00, with nothing saying that every one of them carries no balance
     and so leaves nothing unaccounted for. The count is the database's; the
     explanation is this file's job.

     `severity` is what the reader has to DO, not how the code was raised:
       difference -- a number disagrees with another number. Real.
       coverage   -- something was not there to compare. Benign at zero,
                     serious the moment the account carries a balance, which
                     is computed per import rather than assumed.
       detail     -- a note about one line or section, no balance effect. */
  const ISSUES={
    trial_balance_mismatch:{severity:'difference',label:'Closing balance differs from the trial balance',
      meaning:'The closing balance computed from the retained lines is not the balance QuickBooks reports for this account.',
      action:'Do not rely on this window for this account until it is explained. Re-fetch the period, or archive it in smaller windows to find where the two diverge.'},
    movement_total_mismatch:{severity:'difference',label:'Period movement does not tie to QuickBooks’ own total',
      meaning:'The retained lines for this account do not add up to the section total QuickBooks printed for them.',
      action:'A line is missing or duplicated inside the account. Re-fetch this period before relying on it.'},
    running_balance_gap:{severity:'difference',label:'A running balance does not follow the line before it',
      meaning:'QuickBooks’ own running balance jumps between two consecutive retained lines, so a line between them is missing.',
      action:'Re-fetch this period. The gap names where to look.'},
    missing_ledger_account:{severity:'coverage',label:'In the trial balance, no lines in this window',
      meaning:'The account is on the trial balance but the general ledger returned no lines for it between these dates.',
      zeroAction:'QuickBooks returned no ledger section for this account and its closing balance is zero, so no closing balance is unaccounted for. Whether it had activity in this window that the report did not return cannot be confirmed from here — an account whose debits and credits net to zero would look the same. That is why it is listed rather than passed.',
      balanceAction:'A closing balance with no detail behind it. Archive the period in which this account was active before relying on this window for it.'},
    no_ledger_rows:{severity:'coverage',label:'Account section present but empty',
      meaning:'QuickBooks printed a section for this account and put no lines in it.',
      zeroAction:'The section is empty and the closing balance is zero, so no closing balance is unaccounted for. An empty section is not proof that the account had no activity — only that none was returned.',
      balanceAction:'The account holds a balance but the ledger returned none of the lines behind it. Re-fetch this period.'},
    missing_trial_balance_account:{severity:'coverage',label:'In the ledger, absent from the trial balance',
      meaning:'Lines were retained for this account but the trial balance does not list it, so its closing balance cannot be checked against anything.',
      zeroAction:'The retained lines net to zero, so no closing balance is at stake. Nothing confirms that figure, because the account is not on the trial balance to compare it with.',
      balanceAction:'The retained lines net to a balance that nothing confirms. Check the account in QuickBooks before relying on this window.'},
    missing_transaction_reference:{severity:'detail',label:'A retained line has no source transaction ID',
      meaning:'The line is archived in full, but without QuickBooks’ own transaction id there is no way to trace it back to its source document.',
      action:'Balances are unaffected. It limits tracing that line later, nothing else.'},
    unattributed_ledger_section:{severity:'detail',counted:false,label:'QuickBooks’ own “Not Specified” group',
      meaning:'Records QuickBooks generates itself to link credits. They belong to no account and carry no amount, and every line is retained under a placeholder rather than filed against an account that is not theirs.',
      action:'No action. The section is proved to be all zeroes before it is admitted, which is why it is not counted as an exception.'},
  };
  // An unrecognised code is humanised rather than shown as raw snake_case --
  // unattributed_ledger_section reached this screen that way.
  const issueLabel=code=>ISSUES[code]?.label||String(code).replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
  const num=value=>value==null||value===''?null:(Number.isFinite(Number(value))?Number(value):null);

  /* One row's worth of judgement, from the row itself. A coverage issue on an
     account carrying a balance is a different fact from the same issue at
     zero, so severity is decided per row and never from the code alone. */
  function classify(row){
    const codes=Array.isArray(row&&row.issues)?row.issues:[];
    if(!codes.length)return {severity:'matched',codes:[],balance:0};
    const balance=Math.abs(num(row.trial_balance_debit_net)??num(row.ledger_debit_net)??0);
    let severity='detail';
    for(const code of codes){
      const kind=ISSUES[code]?.severity||'difference';
      if(kind==='difference'){severity='difference';break;}
      if(kind==='coverage')severity=balance>0?'difference':'coverage';
    }
    return {severity,codes,balance};
  }

  /* What the whole reconciliation amounts to: one entry per issue kind with
     its count, how many of those accounts carry a balance, and how much. The
     page prints this instead of leaving a reader to scan 264 rows. */
  function summarise(reconciliation){
    const rows=Array.isArray(reconciliation)?reconciliation:[];
    const groups=new Map();
    let matched=0,flagged=0,exceptions=0,atRiskAccounts=0,atRiskBalance=0;
    for(const row of rows){
      const {severity,codes,balance}=classify(row);
      if(!codes.length){matched++;continue;}
      flagged++;
      // The archive does not count every note as an exception -- the
      // "Not Specified" placeholder is proved all-zero before admission and
      // is excluded on purpose. Tracking that here is what lets the page's
      // own wording agree with exception_count instead of saying 72 beside 71.
      if(codes.some(code=>ISSUES[code]?.counted!==false))exceptions++;
      // Every difference-severity row needs attention. The BALANCE affected is
      // a separate figure: retained detail that is missing or duplicated can
      // still net to a zero closing balance, and reporting only the balance
      // told the reader "0 accounts need attention" about a row this very
      // function had just classified as needing it.
      if(severity==='difference'){atRiskAccounts++;atRiskBalance+=balance;}
      for(const code of codes){
        const g=groups.get(code)||{code,accounts:0,withBalance:0,balanceTotal:0,examples:[]};
        g.accounts++;
        if(balance>0){g.withBalance++;g.balanceTotal+=balance;}
        if(g.examples.length<3&&row.account_name)g.examples.push(String(row.account_name));
        groups.set(code,g);
      }
    }
    const rank={difference:0,coverage:1,detail:2};
    const list=[...groups.values()].map(g=>Object.assign(g,{
      severity:g.withBalance>0&&ISSUES[g.code]?.severity==='coverage'?'difference':(ISSUES[g.code]?.severity||'difference'),
    })).sort((a,b)=>(rank[a.severity]-rank[b.severity])||(b.accounts-a.accounts));
    return {total:rows.length,matched,flagged,exceptions,groups:list,
      exceptionGroups:list.filter(g=>ISSUES[g.code]?.counted!==false),
      atRiskAccounts,atRiskBalance,
      // Every flagged account is a coverage or detail note and none carries a
      // balance: the balances all tie and nothing is unaccounted for.
      balancesAllTie:list.every(g=>g.severity!=='difference')};
  }

  /* One block per issue kind: what it means, what it asks of you, and the
     accounts it names. Written from the rows, so the zero-balance and
     carries-a-balance cases cannot be described with the same sentence. */
  function kpi(label,value,note,tone){
    return `<div class="bcn-kpi"><span class="bcn-kpi-label">${esc(label)}</span>`
      +`<span class="bcn-kpi-value${tone?' books-kpi-value--'+tone:''}">${esc(value)}</span>`
      // A note is escaped text. The one exception is {html}, used where a value
      // must control its own line breaks -- a date broken across lines reads as
      // two numbers -- and every part of it is escaped before it gets here.
      +(note?`<span class="books-kpi-note">${note.html??esc(note)}</span>`:'')+'</div>';
  }
  /* The figures a reader needs before any sentence. atRiskAccounts and the
     balance it affects are kept SEPARATE because retained detail can be
     missing or duplicated and still net to zero: reporting only the balance
     once told the reader "0 accounts need attention" about rows classify()
     had just flagged. */
  function kpis(a,sum){
    const notes=sum.flagged-sum.atRiskAccounts;
    // The window's SHORT name leads and the exact dates sit under it, rather
    // than a raw date at KPI size wrapping mid-value. The currency and basis
    // moved to the snapshot card, which is where a reader asks what this
    // particular archive was recorded in.
    return kpi('Window',windowLabel(a.period_start,a.period_end),{html:`<span class="books-nowrap">${esc(a.period_start)}</span> → <span class="books-nowrap">${esc(a.period_end)}</span>`})
      +kpi('Ledger lines',Number(a.transaction_count||0).toLocaleString('en-US'),'retained in Silo')
      +kpi('Accounts checked',Number(sum.total||0).toLocaleString('en-US'),`${Number(sum.matched||0).toLocaleString('en-US')} tied exactly`)
      +kpi('Needs attention',String(sum.atRiskAccounts),
        sum.atRiskAccounts?'before relying on this window':'every closing balance tied',
        sum.atRiskAccounts?'neg':'pos')
      +kpi('Balance affected',`${amount(sum.atRiskBalance)} ${a.currency}`,
        sum.atRiskBalance?'not confirmed by the trial balance':'none unaccounted for',
        sum.atRiskBalance?'neg':'pos')
      +kpi('Notes',String(notes),notes?'no balance at stake':'none',notes?null:'pos');
  }
  /* One line per kind, with the meaning and the action behind a disclosure.
     Every word of ISSUES is still reachable; what changed is that five
     paragraphs per kind no longer sit open above the table, where 71 benign
     coverage notes read exactly as loudly as a real mismatch. */
  function explain(sum){
    if(!sum.flagged)return '';
    const tone={difference:'neg',coverage:'info',detail:'info'};
    return sum.groups.map(g=>{
      const def=ISSUES[g.code]||{};
      const carries=g.withBalance>0;
      const action=carries?(def.balanceAction||def.action||''):(def.zeroAction||def.action||'');
      const counts=`${g.accounts} account${g.accounts===1?'':'s'}`
        +(def.counted===false?' · not counted':'')
        +(def.severity==='coverage'?(carries
          ? ` · ${g.withBalance} carrying ${amount(g.balanceTotal)}`
          : ' · no balance at stake'):'');
      const body=(def.meaning?`<p>${esc(def.meaning)}</p>`:'')
        +(action?`<p><strong>${carries||g.severity==='difference'?'What to do':'Why it is listed'}:</strong> ${esc(action)}</p>`:'')
        +(g.examples.length?`<p class="books-exception-eg">${g.examples.map(esc).join(' · ')}${g.accounts>g.examples.length?' …':''}</p>`:'');
      return `<div class="books-exception books-exception--${tone[g.severity]||'info'}">`
        +`<div class="books-exception-head"><h3>${esc(issueLabel(g.code))}</h3>`
        +`<p class="books-exception-count">${esc(counts)}</p></div>`
        +(body?`<details><summary>What this means</summary>${body}</details>`:'')
        +'</div>';
    }).join('');
  }


  const result=async query=>{const r=await query;if(r.error)throw new Error(r.error.message);return r.data;};
  const table=(heads,rows)=>'<div class="books-table-scroll"><table><thead><tr>'+heads.map(h=>`<th>${esc(h)}</th>`).join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';
  /* QBO's trial balance is FISCAL-YEAR-TO-DATE for income and expense accounts
     whatever range is asked for. It ignores start_date entirely and echoes the
     requested value back in Header.StartPeriod, so the header cannot be used to
     tell the difference -- measured 2026-09-15, two runs asking for 2025-08-01
     and 2026-01-01 returned BYTE-IDENTICAL rows.

     So the only windows QuickBooks can check in full are those beginning on the
     fiscal year start. A window that crosses the boundary archives every line
     correctly and then reports a mismatch on every P&L account: the
     2025-08-01..2026-07-31 run put 64 accounts out by $33.3m, which was exactly
     its own August-December activity, while every balance-sheet account tied to
     the cent.

     These buttons exist so that window is not reachable rather than merely
     refused. Manual dates stay available for anyone who needs a different one
     and can read the result knowing this. */
  /* What of a window is actually archived. Intersection is NOT coverage: the
     saved windows are walked in date order and whatever they leave behind is
     reported as the gaps it is. Walking in order handles overlapping, adjacent
     and fully-contained windows without a separate merge step -- January-June
     plus July-December leaves no gap and so really does cover the year, while
     one overlapping day leaves the rest of the year as a gap. */
  function coverage(start_date,end_date,archives){
    const day=86400000;
    const ms=d=>Date.parse(d+'T00:00:00Z');
    const at=n=>new Date(n).toISOString().slice(0,10);
    const saved=(archives||[])
      .filter(a=>a&&a.period_start&&a.period_end&&a.period_start<=end_date&&start_date<=a.period_end)
      .sort((x,y)=>x.period_start<y.period_start?-1:x.period_start>y.period_start?1:0);
    const gaps=[];let cur=start_date;
    for(const a of saved){
      if(a.period_start>cur)gaps.push([cur,at(ms(a.period_start)-day)]);
      if(a.period_end>=cur)cur=at(ms(a.period_end)+day);
    }
    if(cur<=end_date)gaps.push([cur,end_date]);
    return {covered:saved.length>0&&gaps.length===0,partial:saved.length>0&&gaps.length>0,gaps};
  }
  function fiscalYears(settings,archives,count=4){
    if(!settings||!settings.accounting_start_date)return [];
    const month=Number(settings.fiscal_year_start_month)||1;
    if(!(month>=1&&month<=12))return [];
    const cut=new Date(settings.accounting_start_date+'T00:00:00Z');
    if(!Number.isFinite(cut.getTime()))return [];
    const iso=d=>d.toISOString().slice(0,10);
    const utc=(y,m)=>new Date(Date.UTC(y,m-1,1));
    const back=d=>{const c=new Date(d.getTime());c.setUTCDate(c.getUTCDate()-1);return c;};
    const last=back(cut);
    let y=last.getUTCFullYear();if((last.getUTCMonth()+1)<month)y-=1;
    const rows=[];
    for(let i=0;i<count;i++,y--){
      const start=utc(y,month);const full=back(utc(y+1,month));
      const end=full>last?last:full;
      // A fiscal year is at most 366 days, so every window offered here is one
      // the archive accepts; the suite asserts that rather than a dead guard.
      if(start>end)continue;
      const start_date=iso(start),end_date=iso(end);
      const exact=(archives||[]).filter(a=>a.period_start===start_date&&a.period_end===end_date)
        .sort((a,b)=>String(a.created_at)<String(b.created_at)?1:-1);
      const newest=exact[0]||null;
      const cov=coverage(start_date,end_date,archives);
      rows.push({label:month===1?String(y):`${y}–${String((y+1)%100).padStart(2,'0')}`,
        start_date,end_date,
        partial:end_date!==iso(full),
        saved:!!newest,
        exceptions:newest?Number(newest.exception_count)||0:null,
        // "Covered" is a claim about the WHOLE year, so it is computed rather
        // than inferred from any intersection: a single overlapping day used to
        // make a year read as covered while eleven months were missing, which
        // would talk a reader out of the archive this control exists to offer.
        covered:!newest&&cov.covered,
        partlyCovered:!newest&&cov.partial,
        gaps:newest?[]:cov.gaps});
    }
    return rows;
  }
  function windowDates(start,end,cutover){
    const date=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
    if(!date(start)||!date(end)||!date(cutover)||start>end||end>=cutover||((Date.parse(end)-Date.parse(start))/86400000)>365)throw new Error('Choose a window of at most 366 days ending before your Silo start date');
    return {start_date:start,end_date:end};
  }
  async function mount({db,companyId}){
    let settings,archives=[],selected=null,offset=0,busy=false,wired=false,ready=false,unfinished=null;
    let shown=4; // fiscal years offered at a time; "Earlier years" asks for more
    let reconRows=[],showAllAccounts=false; // matched accounts are behind a toggle
    let detailLoaded=false;                 // the ledger loads when its card is opened
    // `true` still means an error; a tone string ('pos'/'info'/'neg') lets a
    // good outcome read as one instead of as neutral chrome.
    const status=(message,tone=false)=>{const t=tone===true?'neg':(tone||'');
      el('historyStatus').textContent=message;el('historyStatus').className='bcn-status'+(t?' bcn-status--'+t:'');};
    async function work(fn){if(busy)return;busy=true;el('historyInputs').disabled=true;for(const id of ['historyArchive','historyAccount','historyMore','historyRefresh','historyResume'])el(id).disabled=true;
      try{await fn();}catch(e){status(`${e.message}. Your saved history is unchanged. Check the period and QBO connection, then retry or ask your administrator for help.`,true);}
      finally{busy=false;el('historyInputs').disabled=!settings||!ready;for(const id of ['historyArchive','historyAccount','historyMore','historyRefresh','historyResume'])el(id).disabled=false;}}
    async function lines(reset=false){if(reset){offset=0;el('historyRows').innerHTML='';}if(!selected)return;detailLoaded=true;
      let query=db.from('qbo_history_lines').select('row_no,row_kind,qbo_account_id,account_name,transaction_date,qbo_transaction_id,transaction_type,document_number,counterparty,memo,split_account_id,split_account_name,natural_amount,natural_balance').eq('company_entity_id',companyId).eq('import_id',selected.id);
      if(el('historyAccount').value)query=query.eq('qbo_account_id',el('historyAccount').value);
      const rows=await result(query.order('row_no').range(offset,offset+99));
      if(!offset&&!rows.length)el('historyRows').textContent='No lines for this account. Choose another account or review the reconciliation exceptions below.';
      if(rows.length)el('historyRows').insertAdjacentHTML('beforeend',table(['Date / type','Account / counterparty','Description / reference','Amount','Running balance'],rows.map(r=>`<tr><td>${esc(r.transaction_date||'Beginning balance')}<small>${esc(r.transaction_type)}</small></td><td>${esc(r.account_name)}<small>${esc(r.counterparty)}</small></td><td>${esc(r.memo||r.document_number||'—')}<details><summary>Source details</summary><small>QBO transaction: ${esc(r.qbo_transaction_id||'Not supplied')}<br>Number: ${esc(r.document_number||'Not supplied')}<br>Split: ${esc(r.split_account_name||'Not supplied')} ${r.split_account_id?'('+esc(r.split_account_id)+')':''}</small></details></td><td class="num">${r.row_kind==='opening'?'—':amount(r.natural_amount)}</td><td class="num">${amount(r.natural_balance)}</td></tr>`)));
      offset+=rows.length;el('historyMore').hidden=rows.length<100;
    }
    // The archive is a job: each call checks a bounded slice of the ledger
    // and reports progress; nothing is saved until the last call. A failed
    // call names the row and account, and the evidence tables are untouched.
    async function drive(glRun,tbRun){
      status('Saving immutable history and checking account balances…');
      for(let calls=1;;calls++){
        const r=await result(db.rpc('archive_qbo_ledger',{p_gl_run_id:glRun,p_tb_run_id:tbRun}));
        if(r?.status==='failed')throw new Error(r.error||'History could not be saved');
        if(r?.status==='in_progress'){
          status(`Checking ledger rows… ${Number(r.rows_done).toLocaleString('en-US')} of ${Number(r.rows_total).toLocaleString('en-US')} (${r.sections_done} of ${r.sections_total} accounts). Nothing is saved until every row is checked; you can resume later if this stops.`);
          if(calls>5000)throw new Error('The archive did not finish; refresh saved history and resume');
          continue;
        }
        if(!r?.id)throw new Error('No archive ID was returned; refresh saved history before retrying');
        return r;
      }
    }
    function renderRecon(){
      const flagged=reconRows.filter(x=>x.c.codes.length);
      const rows=showAllAccounts?reconRows:flagged;
      const hidden=reconRows.length-rows.length;
      el('historyShowAll').hidden=!reconRows.length||(!hidden&&!showAllAccounts);
      el('historyShowAll').textContent=showAllAccounts
        ? `Show only accounts needing attention (${flagged.length})`
        : `Show all ${reconRows.length} accounts`;
      if(!rows.length){
        el('historyReconciliation').innerHTML='<p class="books-caption">Every account tied to the trial balance.</p>';
        return;
      }
      el('historyReconciliation').innerHTML=table(['Account','Ledger closing','Trial balance','Difference','Check'],
        rows.map(({r,c})=>`<tr><td>${esc(r.account_name)}</td><td class="num">${amount(r.ledger_debit_net)}</td>`
          +`<td class="num">${amount(r.trial_balance_debit_net)}</td><td class="num">${amount(r.difference)}</td>`
          +`<td>${c.codes.length
            ? c.codes.map(i=>`<span class="bcn-pill ${c.severity==='difference'?'bcn-pill--neg':'bcn-pill--accent'}">${esc(issueLabel(i))}</span>`).join(' ')
            : '<span class="bcn-pill bcn-pill--pos">Matched</span>'}</td></tr>`))
        +(hidden&&!showAllAccounts?`<p class="books-caption">${hidden} account${hidden===1?'':'s'} tied exactly and ${hidden===1?'is':'are'} not listed.</p>`:'');
    }
    async function show(){
      selected=archives.find(a=>a.id===el('historyArchive').value)||null;
      el('historyDetail').hidden=!selected;el('historyChecks').hidden=!selected;
      if(!selected){el('historyKpis').hidden=true;el('historySnapshotTitle').textContent='No snapshots yet';el('historySnapshotState').textContent='';el('historyDetailState').textContent='';
        status(settings?'Pick a year above to save it.':'Open Setup to prepare your opening balances first.');
        el('historySummary').innerHTML='<p class="books-caption">Nothing saved yet.</p>';return;}
      const a=selected;showAllAccounts=false;
      const sum=summarise(a.reconciliation);
      // The count is the archive's; the SHAPE is what makes it readable. "71
      // exceptions" is one thing to understand when all 71 are the same kind.
      const kinds=sum.exceptionGroups.length;
      const shape=!a.exception_count?'Account balances matched'
        :`${a.exception_count} account exception${a.exception_count===1?'':'s'} to review`
          +(kinds===1?` — all of one kind${sum.balancesAllTie?', and no closing balance is affected':''}`
            :sum.balancesAllTie?` across ${kinds} kinds — no closing balance is affected`:'');
      el('historySnapshotTitle').textContent=windowLabel(a.period_start,a.period_end);
      el('historySnapshotState').textContent=`Saved ${savedOn(a.created_at)}`;
      el('historyDetailState').textContent=`${a.reconciliation.length} account${a.reconciliation.length===1?'':'s'}`;
      el('historyKpis').innerHTML=kpis(a,sum);
      el('historyKpis').hidden=false;
      el('historySummary').innerHTML=`<p class="books-caption">${esc(shape)}</p>`
        +`<p class="books-caption">${esc(a.currency)} · ${esc(a.accounting_basis)} · saved ${esc(savedOn(a.created_at))}</p>`;
      el('historyAccount').innerHTML='<option value="">All accounts</option>'+a.reconciliation.map(r=>`<option value="${esc(r.qbo_account_id)}">${esc(r.account_name)}</option>`).join('');
      el('historyExceptions').innerHTML=explain(sum);
      el('historyExceptions').hidden=!sum.flagged;
      // Sorted so anything a person must act on is at the top: the 71 benign
      // coverage notes used to sit above a real mismatch purely by luck.
      const order={difference:0,coverage:1,detail:2,matched:3};
      const rows=a.reconciliation.map(r=>({r,c:classify(r)}))
        .sort((x,y)=>(order[x.c.severity]-order[y.c.severity])||(y.c.balance-x.c.balance)
          ||String(x.r.account_name||'').localeCompare(String(y.r.account_name||'')));
      // Every account is still here; the ones that tied exactly are behind a
      // toggle. Listing 450 matched accounts above the handful that need
      // reading is what buried the real ones.
      reconRows=rows;
      renderRecon();
      // The ledger card starts closed, so its lines are not fetched until it is
      // opened. Selecting a snapshot used to pull a page of ledger rows nobody
      // had asked to see.
      el('historyDetail').open=false;detailLoaded=false;el('historyRows').innerHTML='';
      // The figures are in the band above; the status says what to DO.
      status(!a.exception_count?'Saved. Every closing balance tied to the trial balance.'
        :sum.balancesAllTie?`Saved. Every closing balance tied; ${sum.exceptions} account${sum.exceptions===1?' carries a note':'s carry notes'} about detail that could not be compared.`
        :`${sum.atRiskAccounts} account${sum.atRiskAccounts===1?' needs':'s need'} attention before this window is relied on — listed first below.`,
        !a.exception_count?'pos':sum.balancesAllTie?'info':'neg');
    }
    async function refresh(prefer){
      settings=await result(db.from('accounting_settings').select('qbo_connection_id,accounting_start_date,accounting_basis,base_currency,fiscal_year_start_month').eq('company_entity_id',companyId).maybeSingle());
      // Paginate archives without downloading their raw report copies.
      archives=[];for(let page=0;;page+=100){const rows=await result(db.from('qbo_history_imports').select('id,period_start,period_end,currency,accounting_basis,created_at,exception_count,transaction_count,reconciliation').eq('company_entity_id',companyId).order('created_at',{ascending:false}).order('id').range(page,page+99));archives.push(...rows);if(rows.length<100)break;}
      // An unfinished job (the tab was closed, the network dropped) can be
      // resumed with its stored reports; no new QBO fetch is needed. Older
      // deployments without the jobs table simply show no resume control.
      try{unfinished=(await result(db.from('qbo_history_jobs').select('id,gl_run_id,tb_run_id,rows_done,rows_total,status').eq('company_entity_id',companyId).eq('status','running').order('created_at',{ascending:false}).range(0,0)))[0]||null;}catch{unfinished=null;}
      el('historyResume').hidden=!unfinished;
      if(unfinished)el('historyResume').textContent=`Resume unfinished archive (${Number(unfinished.rows_done).toLocaleString('en-US')} of ${Number(unfinished.rows_total).toLocaleString('en-US')} rows checked)`;
      ready=true;
      el('historyArchive').innerHTML=archives.length?archives.map(a=>`<option value="${esc(a.id)}">${esc(windowLabel(a.period_start,a.period_end))} · ${a.exception_count?esc(a.exception_count)+' exception'+(a.exception_count===1?'':'s'):'Matched'}</option>`).join(''):'<option value="">No saved history</option>';
      if(prefer&&archives.some(a=>a.id===prefer))el('historyArchive').value=prefer;
      // Never print `undefined` at a reader: an absent setting is omitted.
      el('historyConnection').textContent=settings
        ?['Uses your QBO company selected in Setup',settings.base_currency,settings.accounting_basis]
           .filter(Boolean).join(' · ')+(settings.accounting_start_date?`. Silo starts ${settings.accounting_start_date}.`:'.')
        :'Prepare your opening balances in Setup before importing history.';
      renderYears();
      await show();
    }
    /* A picture of what is archived, read left to right in time. Each fiscal
       year is a segment; the bar inside it is how much of that year is saved,
       so a glance answers "what do I have" without reading a word. The open
       year fills only as far as its end date, and the Silo cutover closes the
       strip. Clicking a segment saves that year. */
    function renderYears(){
      const years=fiscalYears(settings,archives,shown).slice().reverse();
      el('historyMoreYears').hidden=!years.length||shown>=12;
      const open=years.find(y=>y.partial)||null;
      const days=(a,b)=>(Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000+1;
      el('historyYears').innerHTML=years.map(y=>{
        const covered=y.saved?1:y.gaps&&y.gaps.length
          ? Math.max(0,1-y.gaps.reduce((t,[a,b])=>t+days(a,b),0)/days(y.start_date,y.end_date))
          : 0;
        const pct=Math.round(covered*100);
        const state=y.saved?(y.exceptions?`${y.exceptions} to review`:'matched')
          :y.covered?'covered elsewhere'
          :y.partlyCovered?`${pct}% saved`
          :'not saved';
        const tone=y.saved?(y.exceptions?'is-saved':'is-clean'):y.partlyCovered||y.covered?'is-part':'is-empty';
        return `<button type="button" class="books-seg ${tone}" data-start="${esc(y.start_date)}" data-end="${esc(y.end_date)}"${y.partial?' data-editable="1"':''}`
          +` title="${esc(y.start_date)} → ${esc(y.end_date)}">`
          +`<span class="books-seg-year">${esc(y.label)}</span>`
          +`<span class="books-seg-bar"><i style="width:${y.saved?100:pct}%"></i></span>`
          +`<span class="books-seg-state">${esc(state)}</span></button>`;}).join('')
        +(years.length?`<span class="books-seg-now" aria-hidden="true"><span class="books-seg-now-tick"></span><span class="books-seg-now-label">Silo<br>starts</span></span>`:'');
      if(open){
        el('historyYearThrough').hidden=false;
        el('historyYearThroughLabel').textContent=`${open.label} through`;
        const input=el('historyYearEnd');
        input.min=open.start_date;input.max=open.end_date;
        const v=input.value;
        if(!/^\d{4}-\d{2}-\d{2}$/.test(v||'')||v<open.start_date||v>open.end_date)input.value=open.end_date;
      } else el('historyYearThrough').hidden=true;
    }
    // One archive path. The year buttons fill the same two fields and run this,
    // so a fiscal year and a hand-typed window cannot drift apart.
    async function archiveWindow(from,through){
      // Re-read settings: another reviewer may have changed a draft cutover.
      settings=await result(db.from('accounting_settings').select('*').eq('company_entity_id',companyId).maybeSingle());
      if(!settings)throw new Error('Prepare opening balances in Setup first');
      // windowDates stays as the backstop even though the years cannot produce
      // a window it rejects: it is the one place that knows the archive's own
      // limits, and a future caller should meet them here rather than at QBO.
      const dates=windowDates(from,through,settings.accounting_start_date);
      const params={...dates,accounting_method:settings.accounting_basis};
      status('Reading your general ledger from QuickBooks…');
      const gl=await result(db.functions.invoke('quickbooks-report',{body:{connection_id:settings.qbo_connection_id,report_name:'GeneralLedger',params}}));
      if(!gl?.run_id)throw new Error(gl?.error||'QBO did not save the general ledger report');
      status('Reading the same-period trial balance for reconciliation…');
      // The trial balance must cover THE SAME PERIOD as the ledger. QBO reports
      // it fiscal-year-to-date regardless (see fiscalYears above), so asking for
      // the ledger's own window is the honest request even though the provider
      // narrows it; the year buttons are what make the two actually agree.
      const tb=await result(db.functions.invoke('quickbooks-report',{body:{connection_id:settings.qbo_connection_id,report_name:'TrialBalance',params}}));
      if(!tb?.run_id)throw new Error(tb?.error||'QBO did not save the trial balance report');
      const saved=await drive(gl.run_id,tb.run_id);
      await refresh(saved.id);
    }
    // Wire before first load so a missing migration can be retried in place.
    if(!wired){wired=true;
      el('historyRefresh').addEventListener('click',()=>work(()=>refresh(selected?.id)));
      el('historyArchive').addEventListener('change',()=>work(show));el('historyAccount').addEventListener('change',()=>work(()=>lines(true)));el('historyMore').addEventListener('click',()=>work(()=>lines()));
      el('historyDetail').addEventListener('toggle',()=>{if(el('historyDetail').open&&!detailLoaded)work(()=>lines(true));});
      el('historyYears').addEventListener('click',e=>{
        const t=e&&e.target;const b=t&&typeof t.closest==='function'?t.closest('button[data-start]'):t;
        const at=k=>b&&(b.dataset?b.dataset[k]:b.getAttribute&&b.getAttribute('data-'+k));
        const start=at('start');let end=at('end');
        if(!start||!end)return;
        // The open year's end is the reader's to choose, bounded by the year
        // itself; anything outside it is refused by name rather than silently
        // clamped, because a window that is not the one they asked for would
        // reconcile fine and answer the wrong question.
        if(at('editable')){
          const chosen=el('historyYearEnd').value;
          if(chosen&&chosen!==end){
            if(!/^\d{4}-\d{2}-\d{2}$/.test(chosen)||chosen<start||chosen>end){
              work(async()=>{throw new Error(`Choose an end date between ${start} and ${end}`);});return;
            }
            end=chosen;
          }
        }
        work(()=>archiveWindow(start,end));
      });
      el('historyMoreYears').addEventListener('click',()=>{shown+=4;work(async()=>{renderYears();});});
      el('historyShowAll').addEventListener('click',()=>{showAllAccounts=!showAllAccounts;renderRecon();});
      // The cap lives in renderYears' hidden rule, which retires the control at
      // twelve years, so `shown` cannot climb past it and needs no second clamp.
      el('historyResume').addEventListener('click',()=>work(async()=>{
        if(!unfinished)throw new Error('There is no unfinished archive to resume');
        const saved=await drive(unfinished.gl_run_id,unfinished.tb_run_id);
        await refresh(saved.id);
      }));
    }
    await work(()=>refresh());
  }
  window.SiloQboHistory={mount,summarise,classify,issueLabel,fiscalYears,explain,windowLabel,ISSUES};
})();
