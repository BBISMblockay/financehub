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
--    affiliate's credited orders brought in (each once, at its attribution's
--    current commissionable base), and today, the company's own calendar day.
--
-- Idempotent. Apply after 20261110160000, then deploy affiliate-portal.

-- ---------------------------------------------------------------------------
-- 1. Sign-in by email
-- ---------------------------------------------------------------------------

create index if not exists affiliate_notifications_to_email_idx
  on public.affiliate_notifications (lower(to_email), created_at desc);

-- The 10-minute limit is a RESERVATION, taken before any link is minted or
-- mailed: two sign-in requests at once for the same address serialize on this
-- row, and only the one that moves sent_at forward gets anything back. A read
-- of affiliate_notifications alone would let both through, because the mail
-- is recorded only after the provider answers. Keyed by a hash of the
-- normalized address, so the table holds no email. No client role reads it.
create table if not exists public.affiliate_portal_signin_throttle (
  email_hash text primary key,
  sent_at    timestamptz not null default now()
);
alter table public.affiliate_portal_signin_throttle enable row level security;
revoke all on table public.affiliate_portal_signin_throttle from public, anon, authenticated;
comment on table public.affiliate_portal_signin_throttle is
  'Per-address cooldown for portal sign-in by email (sha256 of the lowercased address). Written only by affiliate_portal_signin_subjects; no policies, no client access.';

drop function if exists public.affiliate_portal_signin_subjects(text);
create or replace function public.affiliate_portal_signin_subjects(p_email text)
returns table (
  company_entity_id uuid, program_id uuid, affiliate_id uuid,
  contact_email text, display_name text
)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_hash text;
begin
  if position('@' in v_email) < 2 then return; end if;
  if not exists (select 1 from public.affiliates a
                  where lower(btrim(a.contact_email)) = v_email
                    and a.status in ('active','paused')) then
    return;
  end if;
  -- A portal email from any path (Studio, renewal) in the last 10 minutes.
  if exists (select 1 from public.affiliate_notifications n
              where lower(n.to_email) = v_email
                and n.kind in ('portal_link','link_renewal')
                and n.created_at > now() - interval '10 minutes') then
    return;
  end if;

  v_hash := encode(sha256(convert_to(v_email, 'UTF8')), 'hex');
  insert into public.affiliate_portal_signin_throttle as t (email_hash, sent_at)
  values (v_hash, now())
  on conflict (email_hash) do update set sent_at = excluded.sent_at
    where t.sent_at <= now() - interval '10 minutes';
  if not found then return; end if;   -- another request holds this address's turn

  delete from public.affiliate_portal_signin_throttle where sent_at < now() - interval '1 day';

  return query
    select a.company_entity_id, a.program_id, a.id, a.contact_email, a.display_name
      from public.affiliates a
     where lower(btrim(a.contact_email)) = v_email
       and a.status in ('active','paused')
     order by a.created_at
     limit 10;
end;
$$;
comment on function public.affiliate_portal_signin_subjects(text) is
  'For the portal''s sign-in box: active or paused affiliates whose address on file is this email (at most 10), each to be mailed a fresh portal link at that address. Reserves the address for 10 minutes before returning anything, so concurrent requests mail once; returns nothing while reserved or when a portal email went there in the last 10 minutes. Service role only; the caller answers the same whether or not anything was returned.';

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
        -- Each credited order once, at its CURRENT commissionable base, read
        -- from the attribution: a refund that does not change the commission
        -- (a fixed fee, or rounding) appends no ledger row, so a ledger
        -- basis can be stale. NULL (not 0) when no credited order has a
        -- known base, e.g. only manual adjustments.
        'sales_cents', (
          select sum(at.commissionable_cents)
            from public.affiliate_attributions at
           where at.company_entity_id = v_tok.company_entity_id
             and at.commissionable_cents is not null
             and at.id in (select l2.attribution_id
                             from public.affiliate_commission_ledger l2
                            where l2.company_entity_id = v_tok.company_entity_id
                              and l2.affiliate_id = v_tok.affiliate_id
                              and l2.attribution_id is not null)),
        -- The company's own calendar day, so the page judges a code's dates
        -- the way checkout and the feed do.
        'today', (now() at time zone public.silo_company_timezone(v_tok.company_entity_id))::date)
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
