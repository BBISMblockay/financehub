-- Affiliate content: offers and post numbers (20261125230000).
--
-- Blake 2026-11-25 ("and content views", then "go on both"): the posts
-- affiliates send in become a content view with views, engagement, Buy and
-- Offer.
--
--   Buy    -- the existing affiliate_content_decide('use'): the program's flat
--             content bonus, one press, payout approvers only. Unchanged.
--   Offer  -- a price for ONE post, named by a payout approver
--             (affiliate_content_offer). Nothing is owed until the affiliate
--             accepts it in their portal (affiliate_portal_content_answer);
--             only then is the post 'used' and the price written once to
--             affiliate_commission_ledger as a manual_adjustment, paid through
--             the normal payout approval like any bonus.
--             Any decision on the post after the offer was made (Keep, Not
--             used, Buy) voids it, so an old offer can never be accepted on a
--             post the brand has since judged again.
--   Stats  -- view / like / comment counts, duration and a thumbnail, written
--             only by affiliate-research (service role) from the official
--             YouTube Data API for a YouTube link. NULL is "not measured":
--             an uploaded file or an Instagram / TikTok link has no numbers
--             SILO can read, and stays blank, never 0.
--
-- Additive: nullable columns, two checks, two functions, and the portal's
-- read re-created with the offer fields (purposes 'portal' and 'preview' kept
-- from 20261125030000). Idempotent.

-- ── 1. Columns ──────────────────────────────────────────────────────────
alter table public.affiliate_content_submissions add column if not exists offer_cents bigint;
alter table public.affiliate_content_submissions add column if not exists offer_currency text;
alter table public.affiliate_content_submissions add column if not exists offer_state text;
alter table public.affiliate_content_submissions add column if not exists offered_at timestamptz;
alter table public.affiliate_content_submissions add column if not exists offered_by uuid references public.profiles(id);
alter table public.affiliate_content_submissions add column if not exists offer_answered_at timestamptz;

alter table public.affiliate_content_submissions add column if not exists view_count bigint;
alter table public.affiliate_content_submissions add column if not exists like_count bigint;
alter table public.affiliate_content_submissions add column if not exists comment_count bigint;
alter table public.affiliate_content_submissions add column if not exists duration_seconds integer;
alter table public.affiliate_content_submissions add column if not exists thumbnail_url text;
alter table public.affiliate_content_submissions add column if not exists stats_source text;
alter table public.affiliate_content_submissions add column if not exists stats_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_content_offer_shape') then
    alter table public.affiliate_content_submissions add constraint affiliate_content_offer_shape check (
      (offer_state is null and offer_cents is null)
      or (offer_state in ('open', 'accepted', 'declined', 'withdrawn')
          and offer_cents between 1 and 100000000 and offer_currency ~ '^[A-Z]{3}$' and offered_at is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'affiliate_content_stats_shape') then
    alter table public.affiliate_content_submissions add constraint affiliate_content_stats_shape check (
      (view_count is null or view_count >= 0) and (like_count is null or like_count >= 0)
      and (comment_count is null or comment_count >= 0)
      and (duration_seconds is null or duration_seconds between 0 and 86400)
      -- Only the platform's own image host: this URL is rendered in Studio.
      and (thumbnail_url is null or thumbnail_url ~ '^https://i[0-9]?\.ytimg\.com/[A-Za-z0-9_./-]{1,200}$')
      and (stats_source is null or stats_source = 'youtube_api'));
  end if;
end $$;

comment on column public.affiliate_content_submissions.offer_cents is
  'A price offered for THIS post (affiliate_content_offer), in offer_currency. Owed only once the affiliate accepts it (offer_state accepted), and then written once to the ledger as bonus_cents. 20261125230000.';
comment on column public.affiliate_content_submissions.view_count is
  'Views of the linked post as the platform reports them (stats_source), read at stats_at. NULL = not measured (uploads, platforms SILO cannot read), never 0. 20261125230000.';

-- ── 2. A payout approver names a price for one post ─────────────────────
-- p_cents NULL withdraws an open offer. A new price replaces an open one.
create or replace function public.affiliate_content_offer(p_id uuid, p_cents bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid := public.active_company_id();
  v_c record;
begin
  if v_company is null or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_content_offer: only an Affiliate Studio manager can make an offer' using errcode = '42501';
  end if;
  -- Accepting needs no further press, so the offer itself is the money decision.
  if not public.can_approve_affiliate_commissions() then
    raise exception 'affiliate_content_offer: an offer is a payment, so it needs payout approval' using errcode = '42501';
  end if;
  if p_cents is not null and (p_cents < 1 or p_cents > 100000000) then
    raise exception 'affiliate_content_offer: enter an amount' using errcode = '22023';
  end if;

  select c.*, p.currency as program_currency into v_c
    from public.affiliate_content_submissions c
    join public.affiliate_programs p on p.id = c.program_id and p.company_entity_id = c.company_entity_id
   where c.id = p_id and c.company_entity_id = v_company
   for update of c;
  if not found then
    raise exception 'affiliate_content_offer: no such post' using errcode = '42501';
  end if;

  if p_cents is null then
    update public.affiliate_content_submissions
       set offer_state = 'withdrawn', offer_answered_at = now()
     where id = v_c.id and offer_state = 'open';
    return jsonb_build_object('id', v_c.id, 'offer_state', case when found then 'withdrawn' else v_c.offer_state end);
  end if;

  if v_c.state not in ('submitted', 'approved') then
    raise exception 'affiliate_content_offer: this post was already decided' using errcode = '22023';
  end if;
  if v_c.program_currency !~ '^[A-Z]{3}$' then
    raise exception 'affiliate_content_offer: set the program currency first' using errcode = '22023';
  end if;
  update public.affiliate_content_submissions
     set offer_cents = p_cents, offer_currency = v_c.program_currency, offer_state = 'open',
         offered_at = now(), offered_by = auth.uid(), offer_answered_at = null
   where id = v_c.id;
  return jsonb_build_object('id', v_c.id, 'offer_state', 'open', 'offer_cents', p_cents, 'currency', v_c.program_currency);
end;
$$;

revoke all on function public.affiliate_content_offer(uuid, bigint) from public, anon;
grant execute on function public.affiliate_content_offer(uuid, bigint) to authenticated;

-- ── 3. The affiliate answers, from their own portal link (service role) ─
-- The token decides whose post this is. p_offer_cents is the price the
-- affiliate was SHOWN: if the brand changed the offer since, nothing is
-- accepted and they are asked again at the new price. A replay answers the same.
create or replace function public.affiliate_portal_content_answer(p_token_hash text, p_id uuid, p_accept boolean, p_offer_cents bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok    record;
  v_c      record;
  v_ledger uuid;
begin
  select t.company_entity_id, t.affiliate_id into v_tok
    from public.affiliate_access_tokens t
    join public.affiliates a
      on a.id = t.affiliate_id and a.company_entity_id = t.company_entity_id
   where t.token_hash = p_token_hash and t.purpose = 'portal'
     and t.revoked_at is null and t.expires_at > now() and t.affiliate_id is not null
     and a.status = 'active';
  if not found then
    raise exception 'affiliate_portal_content_answer: link is not valid' using errcode = '42501';
  end if;
  select c.* into v_c from public.affiliate_content_submissions c
   where c.id = p_id and c.company_entity_id = v_tok.company_entity_id and c.affiliate_id = v_tok.affiliate_id
   for update;
  if not found then
    raise exception 'affiliate_portal_content_answer: no such post' using errcode = '42501';
  end if;
  if v_c.offer_state in ('accepted', 'declined') then
    return jsonb_build_object('id', v_c.id, 'offer_state', v_c.offer_state, 'state', v_c.state);
  end if;
  -- Withdrawn, never made, or overtaken by a decision on the post since.
  if v_c.offer_state is distinct from 'open' or v_c.state not in ('submitted', 'approved')
     or (v_c.decided_at is not null and v_c.decided_at > v_c.offered_at) then
    raise exception 'affiliate_portal_content_answer: this offer is no longer open' using errcode = '22023';
  end if;
  if p_offer_cents is distinct from v_c.offer_cents then
    raise exception 'affiliate_portal_content_answer: the offer changed; reload to see the new price' using errcode = '22023';
  end if;

  if not coalesce(p_accept, false) then
    update public.affiliate_content_submissions
       set offer_state = 'declined', offer_answered_at = now()
     where id = v_c.id;
    return jsonb_build_object('id', v_c.id, 'offer_state', 'declined', 'state', v_c.state);
  end if;

  insert into public.affiliate_commission_ledger
    (company_entity_id, program_id, affiliate_id, kind, source, amount_cents, currency, memo, created_by)
  values (v_c.company_entity_id, v_c.program_id, v_c.affiliate_id, 'manual_adjustment', 'manual',
          v_c.offer_cents, v_c.offer_currency,
          left('Content offer accepted: ' || coalesce(v_c.caption, case when v_c.kind = 'link' then v_c.link_url else 'upload' end), 300),
          v_c.offered_by)
  returning id into v_ledger;
  update public.affiliate_content_submissions
     set state = 'used', offer_state = 'accepted', offer_answered_at = now(),
         decided_at = now(), decided_by = v_c.offered_by,
         bonus_ledger_id = v_ledger, bonus_cents = v_c.offer_cents, currency = v_c.offer_currency
   where id = v_c.id;
  return jsonb_build_object('id', v_c.id, 'offer_state', 'accepted', 'state', 'used', 'bonus_cents', v_c.offer_cents);
end;
$$;

revoke all on function public.affiliate_portal_content_answer(text, uuid, boolean, bigint) from public, anon, authenticated;
grant execute on function public.affiliate_portal_content_answer(text, uuid, boolean, bigint) to service_role;

-- ── 4. The portal's read carries an open offer ──────────────────────────
-- Same body as live (20261117050000 with 20261125030000's purposes), plus
-- the offer. An offer counts as open here by the same rule the answer uses.
create or replace function public.affiliate_portal_content(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok record;
begin
  select t.company_entity_id, t.program_id, t.affiliate_id, p.content_bonus_cents, p.currency into v_tok
    from public.affiliate_access_tokens t
    join public.affiliate_programs p on p.id = t.program_id and p.company_entity_id = t.company_entity_id
   where t.token_hash = p_token_hash and t.purpose in ('portal', 'preview')
     and t.revoked_at is null and t.expires_at > now() and t.affiliate_id is not null;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'bonus_cents', v_tok.content_bonus_cents,
    'currency', v_tok.currency,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'kind', c.kind, 'file_type', c.file_type, 'link_url', c.link_url,
               'caption', c.caption, 'state', c.state, 'bonus_cents', c.bonus_cents,
               'currency', c.currency, 'submitted_at', c.submitted_at, 'decided_at', c.decided_at,
               'offer_state', case
                 when c.offer_state = 'open' and (c.state not in ('submitted', 'approved')
                      or (c.decided_at is not null and c.decided_at > c.offered_at)) then null
                 when c.offer_state = 'withdrawn' then null
                 else c.offer_state end,
               'offer_cents', case when c.offer_state in ('open', 'accepted', 'declined') then c.offer_cents end,
               'offer_currency', case when c.offer_state in ('open', 'accepted', 'declined') then c.offer_currency end)
             order by c.submitted_at desc)
        from (select * from public.affiliate_content_submissions c
               where c.company_entity_id = v_tok.company_entity_id and c.affiliate_id = v_tok.affiliate_id
                 and c.state <> 'uploading'
               order by c.submitted_at desc limit 100) c), '[]'::jsonb));
end;
$$;

revoke all on function public.affiliate_portal_content(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_content(text) to service_role;

select public.refresh_chat_schema_catalog();
