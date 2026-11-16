-- ============================================================
-- Restore the single-store rule in the portal's feed.
--
-- 20261110160000 gave every affiliate link one rule for which store it opens:
-- affiliate_program_store_url(), which returns the program's own address, else
-- the company's Shopify domain ONLY when the company has exactly one active
-- store, and otherwise NULL so the brand is asked rather than guessed at. Two
-- later migrations then `create or replace`d affiliate_portal_feed() from the
-- pre-160000 text -- 20261113070000 to add launch claims, 20261113093000 to add
-- product ids -- and each one silently carried back the body that picks
-- `order by sc.created_at limit 1`. A company with several active Shopify
-- connections (retail, wholesale) has had the oldest one guessed for it since.
--
-- Nothing else about the feed changes: this is 20261113093000's function with
-- its store SELECT replaced by the call, so the rule lives in one place again.
-- The existing verify check "Affiliate codes via AI" asserts the call is
-- present and has been reporting BROKEN on production since 20261113070000 was
-- applied; it reads ok after this.
--
-- Generic: no company, store or program is named anywhere.
-- ============================================================

create or replace function public.affiliate_portal_feed(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok   record;
  v_today date;
  v_store text;
begin
  select t.company_entity_id, t.program_id, t.affiliate_id into v_tok
    from public.affiliate_access_tokens t
    join public.affiliates a
      on a.id = t.affiliate_id and a.company_entity_id = t.company_entity_id and a.program_id = t.program_id
   where t.token_hash = p_token_hash
     and t.purpose = 'portal'
     and t.revoked_at is null
     and t.expires_at > now()
     and a.status in ('active', 'paused');
  if not found then
    return null;
  end if;

  v_today := (now() at time zone public.silo_company_timezone(v_tok.company_entity_id))::date;

  -- One rule for where an affiliate link opens, shared with the code tools:
  -- the program's own address, else the company's Shopify domain ONLY when
  -- there is exactly one active store, else NULL. Never picked here.
  v_store := public.affiliate_program_store_url(v_tok.company_entity_id, v_tok.program_id);

  return jsonb_build_object(
    'store_url', v_store,
    'codes', (
      select coalesce(jsonb_agg(c.code order by c.starts_on desc, c.code), '[]'::jsonb)
        from public.affiliate_codes c
       where c.company_entity_id = v_tok.company_entity_id
         and c.affiliate_id = v_tok.affiliate_id
         and c.status = 'active'
         and c.starts_on <= v_today
         and (c.ends_on is null or c.ends_on >= v_today)),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', f.id,
               'kind', f.kind, 'title', f.title, 'note', f.note, 'image_url', f.image_url,
               'product_path', f.product_path, 'event_on', f.event_on, 'shared_at', f.shared_at,
               -- A launch the affiliate has claimed, and what it asks them to
               -- push. Products shared UNDER a launch are not loose feed
               -- cards: they belong to that launch's row.
               'claimed', f.kind = 'launch' and exists (
                  select 1 from public.affiliate_launch_claims k
                   where k.feed_item_id = f.id and k.affiliate_id = v_tok.affiliate_id),
               'push', case when f.kind = 'launch' then (
                  select coalesce(jsonb_agg(jsonb_build_object(
                           'id', g.id, 'title', g.title, 'image_url', g.image_url, 'product_path', g.product_path)
                         order by g.title), '[]'::jsonb)
                    from public.affiliate_feed_items g
                   where g.company_entity_id = f.company_entity_id
                     and g.program_id = f.program_id
                     and g.parent_source_id = f.source_id) end)
             order by case f.kind when 'launch' then 0 when 'product' then 1 else 2 end,
                      f.event_on nulls last, f.shared_at desc), '[]'::jsonb)
        from (select * from public.affiliate_feed_items f
               where f.company_entity_id = v_tok.company_entity_id
                 and f.program_id = v_tok.program_id
                 -- A product shared under a launch is shown on that launch.
                 and f.parent_source_id is null
                 -- A launch that has passed drops out of "upcoming" by itself.
                 and not (f.kind = 'launch' and f.event_on is not null and f.event_on < v_today)
               order by f.shared_at desc
               limit 60) f));
end;
$$;

comment on function public.affiliate_portal_feed(text) is
  'For the affiliate-portal function: the feed of a valid portal link of an active or paused affiliate -- the items its program shared (each with its id, whether this affiliate claimed it, and for a launch the products shared under it), the store address from affiliate_program_store_url(), and the affiliate''s codes in effect today. NULL for anything else. Service role only. 20261110150000, claims 20261113070000, pushed product ids 20261113093000, store rule restored 20261116060000.';

-- security definer, so the grants are the boundary: nothing client-facing may
-- call it. Re-stated because a create or replace keeps whatever grants the
-- function already had, and the point of this file is to stop trusting that.
revoke all on function public.affiliate_portal_feed(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_feed(text) to service_role;
