-- Affiliate portal sign-in by email, and "sales you drove" on the statement.
--
-- 1. affiliate_portal_signin_subjects(email): an affiliate who lost their
--    portal email types their address on the portal; the affiliate-portal
--    function mails a fresh portal link to every active or paused affiliate
--    record with that address on file. The page answers the same whether or
--    not the address is known, and this function returns NOTHING when that
--    address was mailed a portal link in the last 10 minutes, so the form
--    cannot be used to flood someone's inbox. Service role only.
-- 2. affiliate_portal_statement: totals gain sales_cents, the sales the
--    affiliate's orders brought in (each order counted once, at its latest
--    commissionable base). NULL when no ledger row carries a base, never 0.
--
-- Idempotent. Apply after 20261110160000, then deploy affiliate-portal.

-- ---------------------------------------------------------------------------
-- 1. Sign-in by email
-- ---------------------------------------------------------------------------

create index if not exists affiliate_notifications_to_email_idx
  on public.affiliate_notifications (lower(to_email), created_at desc);

create or replace function public.affiliate_portal_signin_subjects(p_email text)
returns table (
  company_entity_id uuid, program_id uuid, affiliate_id uuid,
  contact_email text, display_name text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with e as (select lower(btrim(coalesce(p_email, ''))) as v)
  select a.company_entity_id, a.program_id, a.id, a.contact_email, a.display_name
  from public.affiliates a, e
  where position('@' in e.v) > 1
    and lower(btrim(a.contact_email)) = e.v
    and a.status in ('active','paused')
    -- One portal email per address per 10 minutes, whatever asked for it.
    and not exists (
      select 1 from public.affiliate_notifications n
       where lower(n.to_email) = e.v
         and n.kind in ('portal_link','link_renewal')
         and n.created_at > now() - interval '10 minutes')
  order by a.created_at
  limit 10;
$$;
comment on function public.affiliate_portal_signin_subjects(text) is
  'For the portal''s sign-in box: active or paused affiliates whose address on file is this email (at most 10), each to be mailed a fresh portal link at that address. Returns nothing when the address was mailed a portal link in the last 10 minutes. Service role only; the caller answers the same whether or not anything was returned.';

revoke all on function public.affiliate_portal_signin_subjects(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_signin_subjects(text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Statement: sales the affiliate's orders brought in
-- ---------------------------------------------------------------------------

create or replace function public.affiliate_portal_statement(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok record;
  v_out jsonb;
begin
  select t.* into v_tok
    from public.affiliate_access_tokens t
   where t.token_hash = p_token_hash
     and t.revoked_at is null
     and t.expires_at > now();
  if not found then
    raise exception 'affiliate_portal_statement: link is not valid' using errcode = '42501';
  end if;
  if v_tok.affiliate_id is null then
    return jsonb_build_object('entries', '[]'::jsonb, 'codes', '[]'::jsonb,
                              'links', '[]'::jsonb, 'totals', '{}'::jsonb);
  end if;

  -- Deliberately NOT the order list. An affiliate may see what they earned
  -- and on how many orders; the merchant's per-order customer data is not
  -- theirs to read, and this is the one place that line is drawn.
  select jsonb_build_object(
    'affiliate', jsonb_build_object(
      'display_name', a.display_name, 'status', a.status,
      'terms_version_accepted', a.terms_version_accepted,
      'terms_accepted_at', a.terms_accepted_at),
    'currency', p.currency,
    'totals', (
      select jsonb_build_object(
        'earned_cents', coalesce(sum(l.amount_cents), 0),
        'entries', count(*),
        'orders', count(distinct l.order_id),
        'unclaimed_cents', coalesce(sum(l.amount_cents) filter (
          where not exists (select 1 from public.affiliate_payout_items i
                             join public.affiliate_payouts po on po.id = i.payout_id and po.status <> 'void'
                            where i.ledger_entry_id = l.id)), 0),
        'paid_cents', coalesce(sum(l.amount_cents) filter (
          where exists (select 1 from public.affiliate_payout_items i
                         join public.affiliate_payouts po on po.id = i.payout_id and po.status = 'marked_paid'
                        where i.ledger_entry_id = l.id)), 0),
        -- Each order once, at its LATEST base: accrual rows append deltas but
        -- each carries the order's whole current base, so summing them would
        -- count an order again after every refund. NULL (not 0) when no row
        -- carries a base, e.g. only manual adjustments.
        'sales_cents', (
          select sum(s.basis_cents) from (
            select distinct on (l2.attribution_id) l2.basis_cents
              from public.affiliate_commission_ledger l2
             where l2.company_entity_id = v_tok.company_entity_id
               and l2.affiliate_id = v_tok.affiliate_id
               and l2.attribution_id is not null
               and l2.kind in ('accrual','refund_adjustment')
               and l2.basis_cents is not null
             order by l2.attribution_id, l2.created_at desc, l2.id desc) s))
        from public.affiliate_commission_ledger l
       where l.company_entity_id = v_tok.company_entity_id
         and l.affiliate_id = v_tok.affiliate_id),
    'monthly', (
      select coalesce(jsonb_agg(m order by m->>'month'), '[]'::jsonb) from (
        select jsonb_build_object(
                 'month', to_char(date_trunc('month', l.order_day), 'YYYY-MM'),
                 'orders', count(distinct l.order_id),
                 'amount_cents', sum(l.amount_cents)) as m
          from public.affiliate_commission_ledger l
         where l.company_entity_id = v_tok.company_entity_id
           and l.affiliate_id = v_tok.affiliate_id
           and l.order_day is not null
         group by date_trunc('month', l.order_day)) q),
    'codes', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'code', c.code, 'starts_on', c.starts_on, 'ends_on', c.ends_on,
               'status', c.status) order by c.starts_on desc), '[]'::jsonb)
        from public.affiliate_codes c
       where c.company_entity_id = v_tok.company_entity_id
         and c.affiliate_id = v_tok.affiliate_id),
    'links', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'destination_url', k.destination_url, 'utm_source', k.utm_source,
               'utm_medium', k.utm_medium, 'utm_campaign', k.utm_campaign,
               'starts_on', k.starts_on, 'ends_on', k.ends_on, 'status', k.status)
               order by k.starts_on desc), '[]'::jsonb)
        from public.affiliate_links k
       where k.company_entity_id = v_tok.company_entity_id
         and k.affiliate_id = v_tok.affiliate_id),
    'payouts', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'amount_cents', po.amount_cents, 'status', po.status,
               'marked_paid_at', po.marked_paid_at,
               'reference', case when po.status = 'marked_paid' then po.external_reference end)
               order by po.created_at desc), '[]'::jsonb)
        from public.affiliate_payouts po
       where po.company_entity_id = v_tok.company_entity_id
         and po.affiliate_id = v_tok.affiliate_id
         and po.status <> 'void')
  ) into v_out
  from public.affiliates a
  join public.affiliate_programs p on p.id = a.program_id
  where a.id = v_tok.affiliate_id;

  return v_out;
end;
$$;

-- create or replace keeps grants, but restate them: this must never be client-callable.
revoke all on function public.affiliate_portal_statement(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_statement(text) to service_role;
