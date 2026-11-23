-- Two bank or card accounts can feed ONE QuickBooks balancing account.
--
-- Before this, plaid_guard_source_authority refused a second authoritative
-- Plaid source bound to the same (company, QuickBooks connection, QuickBooks
-- account) with 'This QuickBooks account already has an authoritative Plaid
-- feed'. That is a real pattern, not an error: a company can hold two cards on
-- one account in its chart of accounts, and both belong in the same QuickBooks
-- account. Nothing downstream needs the mapping to be one-to-one -- every
-- source already reads its own QuickBooks account (many sources -> one
-- account), batches are per source, and the authoritative cutover and the CSV
-- overlap checks already aggregate with min(authoritative_from) ACROSS every
-- Plaid source on that QuickBooks account, so the earliest feed still governs
-- what CSV may cover.
--
-- Dedupe is unchanged and stays per Plaid account:
-- uq_plaid_transaction_identity(plaid_account_id, external_transaction_id),
-- and plaid_accounts.source_id is unique, so a source still carries at most
-- one Plaid account.
--
-- What the old guard also blocked as collateral is the one case that WOULD
-- double-post: the SAME card arriving a second time under a new Plaid item
-- (a relink), then mapped beside the old one, where every transaction comes
-- back with a new provider id. That check moves to configure_plaid_account,
-- which is the only path that creates a feed and the only place that can see
-- the Plaid account's identity -- the card_sources trigger fires before
-- plaid_accounts.source_id is set, so it cannot judge it. Same institution,
-- same type and the same non-null mask on the same QuickBooks account is
-- refused; two different cards (different mask) are allowed. Fail-soft: an
-- unknown mask never blocks a mapping.
--
-- Generic: no company, entity key or account id appears here.

create or replace function public.plaid_guard_source_authority()
returns trigger language plpgsql security invoker set search_path='public','pg_temp' as $$
declare v_connection uuid; v_cutover date; begin
  if tg_op='UPDATE' and exists(select 1 from public.plaid_accounts where source_id=old.id) and
    (new.company_entity_id,new.qbo_connection_id,new.credit_qbo_account_id,new.source_type,new.ingest_mode,new.authoritative_from)
      is distinct from (old.company_entity_id,old.qbo_connection_id,old.credit_qbo_account_id,old.source_type,old.ingest_mode,old.authoritative_from) then
    raise exception 'A mapped Plaid source cannot be rebound or change its cutover';
  end if;
  if current_user in ('anon','authenticated') and (new.ingest_mode='plaid' or new.authoritative_from is not null)
    and (tg_op='INSERT' or (new.ingest_mode,new.authoritative_from) is distinct from (old.ingest_mode,old.authoritative_from)) then
    raise exception 'Use configure_plaid_account to enable a bank feed';
  end if;
  v_connection:=public.plaid_effective_qbo_connection(new.company_entity_id,new.qbo_connection_id);
  perform public.plaid_lock_financial_account(new.company_entity_id,v_connection,new.credit_qbo_account_id);
  select min(s.authoritative_from) into v_cutover from public.card_sources s
    where s.company_entity_id=new.company_entity_id and s.ingest_mode='plaid'
      and s.qbo_connection_id=v_connection and s.credit_qbo_account_id=new.credit_qbo_account_id;
  if new.ingest_mode='plaid' then
    if new.authoritative_from is null or new.qbo_connection_id is null or new.credit_qbo_account_id is null then
      raise exception 'Plaid source requires an explicit QuickBooks account and cutover date';
    end if;
    -- Several Plaid feeds may share one QuickBooks account. The earliest
    -- cutover across all of them is what CSV must stay clear of, below.
    v_cutover:=least(v_cutover,new.authoritative_from);
    if exists(select 1 from public.card_transactions t join public.card_import_batches b on b.id=t.batch_id
      join public.card_sources s on s.id=b.source_id where t.origin='csv'
        and s.company_entity_id=new.company_entity_id
        and (s.id=new.id or (public.plaid_effective_qbo_connection(s.company_entity_id,s.qbo_connection_id)=v_connection
        and s.credit_qbo_account_id=new.credit_qbo_account_id))
        and (t.txn_date is null or t.txn_date>=v_cutover)) then
      raise exception 'CSV transactions overlap the Plaid cutover for this QuickBooks account';
    end if;
  elsif v_cutover is not null and exists(select 1 from public.card_transactions t join public.card_import_batches b on b.id=t.batch_id
    where b.source_id=new.id and t.origin='csv' and (t.txn_date is null or t.txn_date>=v_cutover)) then
    raise exception 'CSV transactions overlap the authoritative Plaid feed';
  end if;
  return new;
end $$;

-- Identity check for the same card arriving twice (see header). Returns the
-- display name of the feed that already covers it, or null when the mapping is
-- a different account.
create or replace function public.plaid_duplicate_card_feed(p_account_id uuid,p_qbo_connection_id uuid,p_qbo_account_id text)
returns text language sql stable security definer set search_path='public','pg_temp' as $$
  select s.display_name from public.plaid_accounts self
    join public.plaid_connections self_conn on self_conn.id=self.connection_id
    join public.plaid_accounts other on other.company_entity_id=self.company_entity_id
      and other.id<>self.id and other.source_id is not null
      and other.type=self.type and other.mask=self.mask
    join public.plaid_connections other_conn on other_conn.id=other.connection_id
      and other_conn.institution_name is not distinct from self_conn.institution_name
    join public.card_sources s on s.id=other.source_id and s.ingest_mode='plaid'
      and s.qbo_connection_id=p_qbo_connection_id and s.credit_qbo_account_id=p_qbo_account_id
  where self.id=p_account_id and self.mask is not null
  limit 1;
$$;
revoke all on function public.plaid_duplicate_card_feed(uuid,uuid,text) from public,anon,authenticated;

create or replace function public.configure_plaid_account(
  p_account_id uuid,p_qbo_connection_id uuid,p_qbo_account_id text,p_authoritative_from date,p_source_id uuid default null
) returns jsonb language plpgsql security definer set search_path='public','pg_temp' as $$
declare v_company uuid:=public.active_company_id(); v_account public.plaid_accounts%rowtype;
  v_source public.card_sources%rowtype; v_qbo public.quickbooks_accounts%rowtype; v_source_id uuid; v_duplicate text;
begin
  if auth.uid() is null or v_company is null or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then raise exception 'Finance access required'; end if;
  select * into v_account from public.plaid_accounts where id=p_account_id and company_entity_id=v_company for update;
  if not found then raise exception 'Plaid account not found'; end if;
  if v_account.sync_lease_id is not null and v_account.sync_lease_expires_at>now() then raise exception 'Wait for account sync to finish'; end if;
  if v_account.type not in ('depository','credit') then raise exception 'Only bank and credit card accounts are supported'; end if;
  if v_account.iso_currency_code is distinct from 'USD' then raise exception 'Only USD bank and card accounts are supported'; end if;
  if p_authoritative_from is null then raise exception 'An explicit CSV cutover date is required'; end if;
  if not exists(select 1 from public.quickbooks_connections where id=p_qbo_connection_id and company_entity_id=v_company and is_active) then
    raise exception 'QuickBooks connection is not active for this company';
  end if;
  select * into v_qbo from public.quickbooks_accounts where connection_id=p_qbo_connection_id and company_entity_id=v_company
    and qbo_account_id=p_qbo_account_id and is_active;
  if not found or (v_account.type='depository' and v_qbo.account_type<>'Bank')
    or (v_account.type='credit' and v_qbo.account_type not in ('Credit Card','Accounts Payable')) then
    raise exception 'Select the matching bank or card liability account';
  end if;
  if v_qbo.currency is not null and v_qbo.currency<>'USD' then raise exception 'QuickBooks balancing account must use USD'; end if;
  if p_source_id is not null then
    select * into v_source from public.card_sources where id=p_source_id and company_entity_id=v_company for update;
    if not found then raise exception 'Source not found'; end if;
  end if;
  perform public.plaid_lock_financial_account(v_company,p_qbo_connection_id,p_qbo_account_id);
  if v_account.source_id is not null then
    select * into v_source from public.card_sources where id=v_account.source_id;
    if (v_source.qbo_connection_id,v_source.credit_qbo_account_id,v_source.authoritative_from)
      is not distinct from (p_qbo_connection_id,p_qbo_account_id,p_authoritative_from)
      and (p_source_id is null or p_source_id=v_account.source_id) then
      return jsonb_build_object('source_id',v_account.source_id,'already_configured',true);
    end if;
    raise exception 'A mapped feed cannot be rebound or change its cutover';
  end if;
  -- Another card may share this QuickBooks account; the same card may not.
  v_duplicate:=public.plaid_duplicate_card_feed(p_account_id,p_qbo_connection_id,p_qbo_account_id);
  if v_duplicate is not null then
    raise exception 'That card already feeds this QuickBooks account as %',v_duplicate;
  end if;
  if p_source_id is not null then
    select * into v_source from public.card_sources where id=p_source_id and company_entity_id=v_company for update;
    if not found then raise exception 'Source not found'; end if;
    if exists(select 1 from public.plaid_accounts where source_id=p_source_id) then raise exception 'Source already has a Plaid account'; end if;
    if v_source.credit_qbo_account_id is not null and v_source.credit_qbo_account_id<>p_qbo_account_id then
      raise exception 'Existing source has a different balancing account';
    end if;
    if v_source.qbo_connection_id is not null and v_source.qbo_connection_id<>p_qbo_connection_id then
      raise exception 'Existing source has a different QuickBooks connection';
    end if;
    v_source_id:=p_source_id;
    update public.card_sources set qbo_connection_id=p_qbo_connection_id,credit_qbo_account_id=p_qbo_account_id,
      credit_qbo_account_name=v_qbo.name,credit_qbo_account_type=v_qbo.account_type,
      source_type=case when v_account.type='credit' then 'card' else 'bank' end,ingest_mode='plaid',authoritative_from=p_authoritative_from,
      updated_at=now() where id=v_source_id;
  else
    insert into public.card_sources(company_entity_id,source_key,display_name,qbo_connection_id,credit_qbo_account_id,
      credit_qbo_account_name,credit_qbo_account_type,source_type,ingest_mode,authoritative_from,created_by)
      values(v_company,'plaid_'||p_account_id::text,v_account.name,p_qbo_connection_id,p_qbo_account_id,v_qbo.name,v_qbo.account_type,
        case when v_account.type='credit' then 'card' else 'bank' end,'plaid',p_authoritative_from,auth.uid()) returning id into v_source_id;
  end if;
  update public.plaid_accounts set source_id=v_source_id,updated_at=now() where id=p_account_id;
  return jsonb_build_object('source_id',v_source_id);
end $$;
