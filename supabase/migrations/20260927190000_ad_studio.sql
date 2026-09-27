-- ─────────────────────────────────────────────────────────────────────────────
-- Ad Studio: past Meta ads as baselines, and an idea bank measured against them.
--
-- THREE PARTS, one purpose.
--
-- 1. AN IMAGE ARCHIVE. meta_ad_creatives.thumbnail_url is Meta's DEFAULT 64x64
--    thumbnail on a signed fbcdn URL that expires (its `oe=` parameter) about
--    four days after it is fetched. Measured 2026-09-27: 686 of the 811 ads with
--    $100+ spend carried an expired URL, so a gallery of past winners would be
--    mostly broken images. meta-creative-probe.yml (images mode, same day, 8 ads
--    across PHOTO / VIDEO / SHARE, 2025-08 to this week) measured that asking the
--    creative node for thumbnail_width/height=1080 returns 1080x1080 for a photo,
--    540-1080 for a video, and works for ads that ended a year ago -- but every
--    URL still expires. So the sync downloads the image ONCE and keeps it here:
--    image_path names an object in the PRIVATE bucket `ad-creative-images`,
--    content-addressed (<company>/<sha256>.<ext>) so one image used by many ads
--    is stored once. image_sha256 is kept on the row because the same probe
--    found every catalog ad ("All Releases Catalog", "New Releases") returning
--    the IDENTICAL 627x627 file -- a template, not what a shopper saw -- and a
--    shared hash is how the page can say so instead of presenting a placeholder
--    as the creative. image_creative_id records WHICH creative the stored image
--    belongs to: an edited ad gets a new creative id, and the image is then
--    re-fetched rather than trusted. image_attempted_at / image_error make a
--    failed download a recorded state, not an absence.
--
--    ACCESS is the parent-row pattern from docs/ops/storage-isolation.md: the
--    only policy is SELECT, an EXISTS against meta_ad_creatives on image_path,
--    so an object is readable exactly when the caller can read a creative that
--    names it -- and that table is company-scoped by RLS. There is no client
--    write policy at all; the sync writes with the service role.
--
-- 2. ad_studio_ads(p_days) -- per-ad SUMS over the newest p_days of ingested
--    data, plus the creative fields and the archived image. SUMS ONLY, never a
--    ratio: v2/ad-studio.js computes every rate from its parts (pooled, never
--    averaged -- v3/js/metrics.js's rule), so there is one definition of ROAS /
--    CPA / CTR and it lives beside the code that compares them. conversion_value
--    is META-REPORTED (platform-attributed) revenue, not Shopify sales -- the
--    page labels it so. The window ends on the newest INGESTED day, so a missed
--    nightly reads as lag, never as a collapse. thruplays / leads keep their
--    NULL: a video buy that reports no leads was not measured on leads.
--
-- 3. ad_ideas -- the idea bank. An idea names the ads it was built from
--    (baseline_ad_ids) and FREEZES the bar it has to beat (baseline_snapshot)
--    when it is created: measuring a launched idea against a baseline that has
--    since moved would let the bar drift to meet the result. Once live it names
--    the ads that carry it (live_ad_ids), and the page measures those against
--    the frozen bar. Any active member of the company can add and move ideas --
--    it is a shared board, like the launch calendar; only the creator or an
--    admin may delete one.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Image archive ────────────────────────────────────────────────────────
alter table public.meta_ad_creatives
  add column if not exists image_path text,
  add column if not exists image_sha256 text,
  add column if not exists image_width integer,
  add column if not exists image_height integer,
  add column if not exists image_bytes integer,
  add column if not exists image_content_type text,
  add column if not exists image_creative_id text,
  add column if not exists image_archived_at timestamptz,
  add column if not exists image_attempted_at timestamptz,
  add column if not exists image_error text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'meta_ad_creatives_image_path_shape') then
    alter table public.meta_ad_creatives add constraint meta_ad_creatives_image_path_shape
      check (image_path is null
             or image_path ~ '^[0-9a-f-]{36}/[0-9a-f]{64}\.(jpg|png|webp|gif)$');
  end if;
  -- A stored image is a path, a hash and a time together. A path with no hash
  -- cannot be recognised as a shared template; a hash with no path names an
  -- image nobody can open.
  if not exists (select 1 from pg_constraint where conname = 'meta_ad_creatives_image_together') then
    alter table public.meta_ad_creatives add constraint meta_ad_creatives_image_together
      check ((image_path is null) = (image_sha256 is null)
         and (image_path is null) = (image_archived_at is null));
  end if;
end $$;

create index if not exists meta_ad_creatives_image_path_idx
  on public.meta_ad_creatives (image_path) where image_path is not null;
create index if not exists meta_ad_creatives_image_sha_idx
  on public.meta_ad_creatives (company_entity_id, image_sha256) where image_sha256 is not null;

comment on column public.meta_ad_creatives.image_path is
  'Object in the PRIVATE ad-creative-images bucket holding this ad''s image, '
  'archived by the sync because thumbnail_url expires about four days after '
  'it is fetched. <company>/<sha256>.<ext>: content-addressed, so ads sharing '
  'an image share an object. NULL = not archived yet (see image_attempted_at / '
  'image_error), never "the ad has no image".';
comment on column public.meta_ad_creatives.image_sha256 is
  'sha256 of the archived image. Many ads sharing one hash usually means a '
  'catalog / dynamic-product template rather than the image a shopper saw.';
comment on column public.meta_ad_creatives.image_creative_id is
  'The creative_id the archived image was fetched for. When it differs from '
  'creative_id the ad was edited and the image is stale.';

insert into storage.buckets (id, name, public)
values ('ad-creative-images', 'ad-creative-images', false)
on conflict (id) do update set public = false;

drop policy if exists "ad creative images readable with the creative" on storage.objects;
create policy "ad creative images readable with the creative"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'ad-creative-images'
    and exists (select 1 from public.meta_ad_creatives c
                 where c.image_path = name)
  );

-- ── 2. ad_studio_ads ────────────────────────────────────────────────────────
create or replace function public.ad_studio_ads(p_days integer default 365)
returns table (
  ad_id text,
  ad_name text,
  campaign_name text,
  adset_name text,
  objective text,
  first_day date,
  last_day date,
  days_with_spend integer,
  spend numeric,
  impressions bigint,
  clicks bigint,
  conversions numeric,
  conversion_value numeric,
  thruplays bigint,
  leads bigint,
  add_to_cart bigint,
  recent_spend numeric,
  recent_impressions bigint,
  recent_clicks bigint,
  recent_conversions numeric,
  recent_conversion_value numeric,
  early_impressions bigint,
  early_clicks bigint,
  window_start date,
  data_through date,
  effective_status text,
  object_type text,
  body text,
  title text,
  link_url text,
  link_url_source text,
  link_path text,
  preview_shareable_link text,
  thumbnail_url text,
  image_path text,
  image_width integer,
  image_height integer,
  image_shared_by integer
)
language sql
stable
security invoker
set search_path = public
as $fn$
with w as (
  select max(p.day_date) as through,
         max(p.day_date) - (greatest(coalesce(p_days, 36500), 1) - 1) as start
  from public.meta_ad_performance_daily p
  where p.company_entity_id = public.active_company_id()
),
perf as (
  select p.* from public.meta_ad_performance_daily p
  where p.company_entity_id = public.active_company_id()
),
-- Each ad's first 14 days of delivery across ALL data (not just the window):
-- the "when it was fresh" half of a fatigue comparison.
born as (
  select ad_id, min(day_date) as d from perf where impressions > 0 group by ad_id
),
early as (
  select p.ad_id, sum(p.impressions)::bigint as imp, sum(p.clicks)::bigint as clk
  from perf p join born b on b.ad_id = p.ad_id
  where p.day_date between b.d and b.d + 13
  group by p.ad_id
),
agg as (
  select p.ad_id,
         (array_agg(p.ad_name order by p.day_date desc))[1]       as ad_name,
         (array_agg(p.campaign_name order by p.day_date desc))[1] as campaign_name,
         (array_agg(p.adset_name order by p.day_date desc))[1]    as adset_name,
         min(p.day_date) filter (where p.spend > 0)                as first_day,
         max(p.day_date) filter (where p.spend > 0)                as last_day,
         (count(*) filter (where p.spend > 0))::integer            as days_with_spend,
         sum(p.spend)                                              as spend,
         sum(p.impressions)::bigint                                as impressions,
         sum(p.clicks)::bigint                                     as clicks,
         sum(p.conversions)                                        as conversions,
         sum(p.conversion_value)                                   as conversion_value,
         -- sum() of all-NULL is NULL: never measured stays unmeasured.
         sum(p.thruplays)::bigint                                  as thruplays,
         sum(p.leads)::bigint                                      as leads,
         sum(p.add_to_cart)::bigint                                as add_to_cart,
         sum(p.spend)            filter (where p.day_date > w.through - 14) as recent_spend,
         (sum(p.impressions) filter (where p.day_date > w.through - 14))::bigint as recent_impressions,
         (sum(p.clicks) filter (where p.day_date > w.through - 14))::bigint as recent_clicks,
         sum(p.conversions)      filter (where p.day_date > w.through - 14) as recent_conversions,
         sum(p.conversion_value) filter (where p.day_date > w.through - 14) as recent_conversion_value
  from perf p cross join w
  where p.day_date between w.start and w.through
  group by p.ad_id
  having sum(p.spend) > 0
),
shared as (
  select c.image_sha256, count(*)::integer as n
  from public.meta_ad_creatives c
  where c.company_entity_id = public.active_company_id() and c.image_sha256 is not null
  group by c.image_sha256
)
select a.ad_id, a.ad_name, a.campaign_name, a.adset_name,
       public.meta_campaign_group(a.campaign_name) as objective,
       a.first_day, a.last_day, a.days_with_spend,
       a.spend, a.impressions, a.clicks, a.conversions, a.conversion_value,
       a.thruplays, a.leads, a.add_to_cart,
       a.recent_spend, a.recent_impressions, a.recent_clicks, a.recent_conversions, a.recent_conversion_value,
       e.imp, e.clk,
       w.start, w.through,
       c.effective_status, c.object_type, c.body, c.title,
       c.link_url, c.link_url_source, c.link_path, c.preview_shareable_link,
       c.thumbnail_url,
       -- A stored image of a creative the ad no longer runs is not its image.
       case when c.image_creative_id is not distinct from c.creative_id then c.image_path end,
       case when c.image_creative_id is not distinct from c.creative_id then c.image_width end,
       case when c.image_creative_id is not distinct from c.creative_id then c.image_height end,
       case when c.image_creative_id is not distinct from c.creative_id then s.n - 1 end
from agg a
cross join w
left join early e on e.ad_id = a.ad_id
left join public.meta_ad_creatives c
       on c.company_entity_id = public.active_company_id() and c.ad_id = a.ad_id
left join shared s on s.image_sha256 = c.image_sha256
order by a.spend desc;
$fn$;

revoke all on function public.ad_studio_ads(integer) from public, anon;
grant execute on function public.ad_studio_ads(integer) to authenticated;

comment on function public.ad_studio_ads(integer) is
  'Ad Studio''s one read: per Meta ad that spent in the newest p_days of '
  'ingested data (window ends on the newest day in meta_ad_performance_daily, '
  'not today), SUMS of spend / impressions / clicks / conversions / '
  'conversion_value / thruplays / leads, the last 14 days of the window '
  '(recent_*), the ad''s own first 14 days of delivery (early_*), the objective '
  'from meta_campaign_group(), and the creative with its ARCHIVED image '
  '(image_path in the private ad-creative-images bucket; image_shared_by = how '
  'many other ads use the identical image). Sums only -- every rate is computed '
  'from its parts by the reader. conversion_value is Meta-REPORTED revenue. '
  'SECURITY INVOKER: RLS scopes it to the caller''s active company.';

-- ── 3. ad_ideas ─────────────────────────────────────────────────────────────
create table if not exists public.ad_ideas (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id),
  title text not null check (length(btrim(title)) between 1 and 200),
  hook text check (hook is null or length(hook) <= 500),
  angle text check (angle is null or length(angle) <= 2000),
  body_draft text check (body_draft is null or length(body_draft) <= 5000),
  format text check (format is null or format in ('image', 'video', 'carousel', 'ugc', 'catalog', 'other')),
  objective text check (objective is null or objective in ('purchase', 'thruplay', 'subscribers', 'followers', 'traffic', 'other')),
  destination_url text check (destination_url is null or destination_url ~* '^https?://[^\s]+$'),
  baseline_ad_ids text[] not null default '{}',
  baseline_snapshot jsonb,
  status text not null default 'idea'
    check (status in ('idea', 'approved', 'in_production', 'live', 'retired')),
  live_ad_ids text[] not null default '{}',
  notes text check (notes is null or length(notes) <= 5000),
  source text not null default 'manual' check (source in ('manual', 'from_ad', 'ask_silo')),
  created_by uuid default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  -- A live idea names the ads that carry it; otherwise there is nothing to
  -- measure and "live" would be a claim with no evidence behind it.
  constraint ad_ideas_live_names_ads check (status <> 'live' or cardinality(live_ad_ids) > 0),
  constraint ad_ideas_snapshot_is_object check (baseline_snapshot is null or jsonb_typeof(baseline_snapshot) = 'object')
);

create index if not exists ad_ideas_company_status_idx on public.ad_ideas (company_entity_id, status, updated_at desc);

create or replace function public.ad_ideas_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.company_entity_id is distinct from old.company_entity_id then
      raise exception 'ad_ideas: an idea cannot move to another company';
    end if;
    if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'ad_ideas: created_by / created_at are fixed';
    end if;
    -- The bar is frozen once set. Re-baselining is a new idea, so the record
    -- of what the original was measured against survives.
    if old.baseline_snapshot is not null and new.baseline_snapshot is distinct from old.baseline_snapshot then
      raise exception 'ad_ideas: baseline_snapshot is frozen once set -- start a new idea to change the bar';
    end if;
  end if;
  -- approved_by / approved_at are stamped here, never taken from the client:
  -- set on the move INTO approved, kept while the idea moves on through
  -- production and live, cleared if it goes back to a plain idea.
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    new.approved_by := auth.uid();
    new.approved_at := now();
  elsif tg_op = 'INSERT' or new.status = 'idea' then
    new.approved_by := null;
    new.approved_at := null;
  else
    new.approved_by := old.approved_by;
    new.approved_at := old.approved_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_ad_ideas_guard on public.ad_ideas;
create trigger trg_ad_ideas_guard before insert or update on public.ad_ideas
  for each row execute function public.ad_ideas_guard();

alter table public.ad_ideas enable row level security;
revoke all on public.ad_ideas from anon;

drop policy if exists ad_ideas_select on public.ad_ideas;
create policy ad_ideas_select on public.ad_ideas for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists ad_ideas_insert on public.ad_ideas;
create policy ad_ideas_insert on public.ad_ideas for insert to authenticated
  with check (company_entity_id = public.active_company_id() and created_by = auth.uid());

drop policy if exists ad_ideas_update on public.ad_ideas;
create policy ad_ideas_update on public.ad_ideas for update to authenticated
  using (company_entity_id = public.active_company_id())
  with check (company_entity_id = public.active_company_id());

drop policy if exists ad_ideas_delete on public.ad_ideas;
create policy ad_ideas_delete on public.ad_ideas for delete to authenticated
  using (company_entity_id = public.active_company_id()
         and (created_by = auth.uid() or public.is_admin_user()));

comment on table public.ad_ideas is
  'Ad Studio''s idea bank: an ad idea (title, hook, angle, draft copy, format, '
  'objective, destination) built FROM past ads (baseline_ad_ids) with the bar '
  'it must beat FROZEN at creation (baseline_snapshot: objective, the metric it '
  'is judged on, the pooled value and the sums behind it, the window). Status '
  'idea -> approved -> in_production -> live -> retired; a live idea names the '
  'Meta ads carrying it (live_ad_ids) and is measured against the frozen bar, '
  'never against a baseline recomputed later.';

select public.attach_stamp_company_entity_id_triggers();

-- ── Ask SILO catalog ────────────────────────────────────────────────────────
insert into public.silo_chat_schema_catalog (relname, relkind, columns, description, keywords, is_hidden)
values
  ('ad_ideas', 'r', '[]'::jsonb,
   'Ad Studio''s idea bank: ad ideas the team is working on, each built from '
   'past Meta ads (baseline_ad_ids, joinable to meta_ad_creatives.ad_id) with '
   'the bar to beat FROZEN when it was created (baseline_snapshot: objective, '
   'metric, value, the sums behind it and their window). status idea / '
   'approved / in_production / live / retired; live_ad_ids names the ads that '
   'carry a launched idea. baseline_snapshot.value is Meta-REPORTED where the '
   'metric is ROAS. An idea is a plan, never evidence of performance.',
   array['ad ideas','idea bank','creative','ads','ad studio','meta','concepts','hooks'],
   false)
on conflict (relname) do update
  set description = case
        when coalesce(public.silo_chat_schema_catalog.description, '') like '%Ad Studio''s idea bank%'
        then public.silo_chat_schema_catalog.description
        else coalesce(public.silo_chat_schema_catalog.description, '') || excluded.description
      end,
      keywords = coalesce(public.silo_chat_schema_catalog.keywords, excluded.keywords),
      is_hidden = excluded.is_hidden,
      updated_at = now();

select public.refresh_chat_schema_catalog();
