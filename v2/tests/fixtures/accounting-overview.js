/* Entirely synthetic: never production names, identifiers, or balances. */
'use strict';
const companyId = 'test-company';
const scoped = rows => rows.map(row => ({company_entity_id:companyId,...row}));
function fixtures() {
  return {
    accounting_settings:scoped([{bookkeeping_mode:'silo',accounting_start_date:'2026-01-01',base_currency:'USD'}]),
    accounting_opening_balances:scoped([{id:'opening',status:'accepted',accepted_at:'2026-01-03T10:00:00Z'}]),
    accounting_accounts:scoped([{id:'cash',name:'Operating cash'},{id:'card',name:'Corporate card'}]),
    accounting_qbo_connections:[{id:'qbo',company_name:'Example Company',environment:'sandbox',accounts_synced_at:'2026-11-12T08:00:00Z'}],
    plaid_connections:scoped([{id:'bank',institution_name:'Example Bank',environment:'sandbox',status:'active'}]),
    plaid_accounts:scoped([
      {id:'checking',connection_id:'bank',name:'Operating checking',mask:'4321',type:'depository',iso_currency_code:'USD',current_balance:12500,available_balance:12000,balance_updated_at:'2026-11-12T09:00:00Z',last_synced_at:'2026-11-12T09:00:00Z',source_id:'source'},
      {id:'canadian',connection_id:'bank',name:'Canadian checking',type:'depository',iso_currency_code:'CAD',current_balance:4000,balance_updated_at:'2026-11-12T09:00:00Z',source_id:'source-cad'},
      {id:'missing',connection_id:'bank',name:'Reserve checking',type:'depository',iso_currency_code:'USD',current_balance:null},
      {id:'credit',connection_id:'bank',name:'Corporate credit card',type:'credit',iso_currency_code:'USD',current_balance:500,balance_updated_at:'2026-11-12T09:00:00Z'},
      {id:'foreign',company_entity_id:'other-company',connection_id:'bank',name:'OTHER TENANT SECRET',type:'depository',iso_currency_code:'USD',current_balance:999999}
    ]),
    card_sources:scoped([{id:'source',qbo_connection_id:'qbo',display_name:'Operating checking',is_active:true,credit_qbo_account_id:'cash',posting_enabled:true}]),
    card_import_batches_v:scoped([
      {id:'nov-draft',source_id:'source',txn_count:2,source_name:'November operating',label:'November',status:'draft',period_start:'2026-11-01',period_end:'2026-11-30',entry_date:'2026-11-30',posting_status:null},
      {id:'nov-coded',source_id:'source',txn_count:2,source_name:'November coded',status:'categorized',period_start:'2026-11-01',period_end:'2026-11-30',entry_date:'2026-11-30',posting_status:null},
      {id:'oct-approved',source_id:'source',txn_count:2,source_name:'October operating',status:'approved',period_start:'2026-10-01',period_end:'2026-10-31',entry_date:'2026-10-31',posting_status:null},
      {id:'foreign',company_entity_id:'other-company',source_name:'OTHER TENANT SECRET',status:'draft',entry_date:'2026-11-30'}
    ]),
    quickbooks_journal_postings:[],
    accounting_journal_register:scoped([
      {id:'nov-journal',kind:'journal_adjustment',entry_date:'2026-11-10',memo:'November adjustment',status:'draft',source:'manual',posting_status:null},
      {id:'nov-posted',kind:'journal_adjustment',entry_date:'2026-11-09',memo:'November posted entry',status:'posted',source:'manual',posting_status:'posted'},
      {id:'oct-journal',kind:'journal_adjustment',entry_date:'2026-10-31',memo:'October adjustment',status:'approved',source:'manual',posting_status:null}
    ])
  };
}
const rpc = {can_manage_journal_entries:() => true,is_exec_or_owner:() => false,silo_business_today:() => '2026-11-12'};
module.exports = {fixtures,rpc,companyId};
