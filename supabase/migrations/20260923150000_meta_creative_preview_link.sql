-- Meta's shareable preview link for every ad: see the ad itself, as it runs.
--
-- meta_ad_creatives already says where an ad SENDS a click (link_url, #729).
-- It had nothing that shows the ad: the thumbnail is a 64px crop, and the one
-- link a marketer can open -- Ads Manager -- needs a login to the ad account.
-- Meta exposes `preview_shareable_link` on the AD object: an fb.me link to the
-- rendered ad that anyone with the link can open.
--
-- MEASURED FIRST, 2026-09-23, with meta-creative-probe.mjs on the live
-- account: 10 of 10 ads returned one -- PHOTO, VIDEO, SHARE, PAGE and
-- POST_DELETED, from 2018 to this week -- and the account refused nothing.
--
-- The sync writes this column ONLY when Meta returned a link, never NULL over
-- a stored one (a refused or omitted field on one run must not erase what an
-- earlier run found). So a null here means "never returned", not "has none".
--
-- Additive. No policy change: meta_ad_creatives' existing RLS governs it.

alter table public.meta_ad_creatives
  add column if not exists preview_shareable_link text;

-- It is put in an href on three pages, so the same gate every stored link has:
-- http(s), no whitespace or quote characters. The sync enforces it too; this
-- holds for any other writer.
alter table public.meta_ad_creatives
  drop constraint if exists meta_ad_creatives_preview_is_web_url;
alter table public.meta_ad_creatives
  add constraint meta_ad_creatives_preview_is_web_url
  check (preview_shareable_link is null
         or preview_shareable_link ~ '^https?://[^[:space:]<>"'']+$');

comment on column public.meta_ad_creatives.preview_shareable_link is
  'Meta''s shareable preview of the ad itself (an fb.me link from the Ad object''s preview_shareable_link): opens the rendered ad, no Ads Manager login needed. NOT the destination -- that is link_url. Written only when Meta returned one, never nulled by a later sync, so null means never returned rather than none exists.';

-- ── Carry it through to the Marketing Report's creative table ─────────────
-- REWRITES THE DEPLOYED DEFINITION rather than retyping it -- wow_creatives
-- has run ahead of this directory before (20260915150000 records the
-- thruplays/leads drift), so a create-or-replace from a file would risk
-- deleting whatever production carries that the repo does not. Two anchored
-- insertions, each asserted to match exactly once; a body that has changed
-- shape raises instead of guessing. Idempotent: a re-run finds the column
-- already carried and leaves the function alone.
do $mig$
declare
  fn     record;
  def    text;
  newdef text;
  a_sel  constant text := 'c.link_url, c.link_url_source, c.link_path,';
  a_obj  constant text := '''link_path'', a.link_path,';
begin
  for fn in
    select p.oid, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'wow_creatives'
  loop
    def := pg_get_functiondef(fn.oid);
    if position('preview_shareable_link' in def) > 0 then
      raise notice 'wow_creatives(%): preview already carried', fn.args;
      continue;
    end if;
    if (select count(*) from regexp_matches(def, 'c\.link_url, c\.link_url_source, c\.link_path,', 'g')) <> 1
       or (select count(*) from regexp_matches(def, '''link_path'', a\.link_path,', 'g')) <> 1 then
      raise exception 'wow_creatives(%): the link anchors are not each present exactly once -- body has changed, refusing to guess', fn.args;
    end if;
    newdef := replace(def, a_sel, a_sel || ' c.preview_shareable_link,');
    newdef := replace(newdef, a_obj,
      a_obj || E'\n                   -- Meta''s shareable preview of the ad itself. NOT the\n'
            || E'                   -- destination above; null means never returned.\n'
            || '                   ''preview'', a.preview_shareable_link,');
    execute newdef;
    raise notice 'wow_creatives(%): now carries preview', fn.args;
  end loop;
end
$mig$;

-- Ask SILO's catalog: APPEND, never replace (20260910150000 restored two
-- caveats a replace had dropped). Guarded so a re-run appends nothing twice.
update public.silo_chat_schema_catalog
   set description = coalesce(description, '')
     || ' preview_shareable_link is Meta''s shareable fb.me preview of the AD ITSELF -- a link to show someone, not the destination (that is link_url) and not a landing page.'
 where relname = 'meta_ad_creatives'
   and position('preview_shareable_link is Meta''s shareable' in coalesce(description, '')) = 0;

select public.refresh_chat_schema_catalog();
