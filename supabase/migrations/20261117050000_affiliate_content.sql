-- Affiliate content (20261117050000).
--
-- An affiliate shares content they made for the brand from their portal: an
-- uploaded photo or video, or a link to a post. A manager reviews it in
-- Affiliate Studio:
--   approve  -- fine, nothing paid.
--   use      -- the brand picked it. When the program sets a content bonus,
--               that bonus is written once as a manual_adjustment on
--               affiliate_commission_ledger and paid through the normal
--               payout approval. Picking needs the money gate.
--   decline  -- not used.
-- Codes and commissions are untouched: a picked piece pays its bonus on top.
--
-- Files go to the PRIVATE bucket affiliate-content at <submission id>/<name>.
-- The portal never writes storage itself: affiliate-portal asks
-- affiliate_portal_content_start() for a row, then mints a one-object signed
-- upload URL for that row's path. The row stays 'uploading' (hidden from
-- Studio) until affiliate_portal_content_finish() sees the object in
-- storage.objects. Studio reads a file through a signed URL, which the
-- storage policy allows only for a row of the active company.
--
-- Human-controlled by construction: nothing here decides or pays on its own.

-- ── 1. The bonus a picked piece earns ───────────────────────────────────
alter table public.affiliate_programs
  add column if not exists content_bonus_cents bigint;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_programs_content_bonus_shape') then
    alter table public.affiliate_programs add constraint affiliate_programs_content_bonus_shape
      check (content_bonus_cents is null or content_bonus_cents between 1 and 100000000);
  end if;
end $$;

comment on column public.affiliate_programs.content_bonus_cents is
  'What a piece of affiliate content earns when the brand picks it (affiliate_content_decide ''use''), in the program currency. NULL = picking pays nothing extra. 20261117050000.';

-- ── 2. The submissions ──────────────────────────────────────────────────
create table if not exists public.affiliate_content_submissions (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id        uuid not null references public.affiliate_programs(id) on delete cascade,
  affiliate_id      uuid not null references public.affiliates(id) on delete cascade,
  kind              text not null,
  storage_path      text,
  file_type         text,
  file_bytes        bigint,
  link_url          text,
  caption           text,
  state             text not null default 'submitted',
  bonus_cents       bigint,
  currency          text,
  bonus_ledger_id   uuid references public.affiliate_commission_ledger(id),
  submitted_at      timestamptz not null default now(),
  decided_at        timestamptz,
  decided_by        uuid references public.profiles(id),
  constraint affiliate_content_kind check (kind in ('file', 'link')),
  constraint affiliate_content_state check (state in ('uploading', 'submitted', 'approved', 'used', 'declined')),
  constraint affiliate_content_shape check (
    (kind = 'file' and storage_path is not null and link_url is null)
    or (kind = 'link' and storage_path is null and link_url is not null and state <> 'uploading')),
  constraint affiliate_content_path check (storage_path is null or storage_path ~ '^[0-9a-f-]{36}/content\.[a-z0-9]{1,5}$'),
  constraint affiliate_content_link check (link_url is null or (link_url ~ '^https://[^\s"''<>]+$' and length(link_url) <= 500)),
  constraint affiliate_content_caption check (caption is null or length(caption) <= 500),
  constraint affiliate_content_type check (file_type is null or file_type ~ '^(image|video)/[a-z0-9.+-]{1,40}$'),
  constraint affiliate_content_bonus check (
    (bonus_ledger_id is null and bonus_cents is null)
    or (bonus_ledger_id is not null and bonus_cents > 0 and currency ~ '^[A-Z]{3}$' and state = 'used'))
);

create unique index if not exists affiliate_content_bonus_once
  on public.affiliate_content_submissions (bonus_ledger_id) where bonus_ledger_id is not null;
create unique index if not exists affiliate_content_path_once
  on public.affiliate_content_submissions (storage_path) where storage_path is not null;
create index if not exists affiliate_content_open
  on public.affiliate_content_submissions (company_entity_id, program_id, state, submitted_at desc);
create index if not exists affiliate_content_affiliate
  on public.affiliate_content_submissions (company_entity_id, affiliate_id, submitted_at desc);

alter table public.affiliate_content_submissions enable row level security;

drop policy if exists affiliate_content_submissions_select on public.affiliate_content_submissions;
create policy affiliate_content_submissions_select on public.affiliate_content_submissions
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- No write policy: the portal writes through the service-role functions
-- below and a manager decides through affiliate_content_decide().
revoke all on public.affiliate_content_submissions from anon, authenticated;
grant select on public.affiliate_content_submissions to authenticated;
grant all on public.affiliate_content_submissions to service_role;

comment on table public.affiliate_content_submissions is
  'Content an affiliate shared from their portal: an uploaded photo/video (private bucket affiliate-content, path <id>/content.<ext>) or a post link. A manager approves, declines, or uses it; using it writes the program''s content bonus once as a manual_adjustment ledger line (bonus_ledger_id), paid through the normal payout approval. ''uploading'' rows are files whose upload has not finished and are not shown in Studio. 20261117050000.';

-- ── 3. Private storage ──────────────────────────────────────────────────
-- 50 MB is the project's upload ceiling; a phone video over it is refused by
-- storage itself, and the portal says so before it tries.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('affiliate-content', 'affiliate-content', false, 52428800,
        array['image/jpeg','image/png','image/webp','image/gif','image/heic','video/mp4','video/quicktime','video/webm'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "affiliate content readable by its company" on storage.objects;
create policy "affiliate content readable by its company"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'affiliate-content'
    and exists (select 1 from public.affiliate_content_submissions s
                 where s.storage_path = name
                   and s.company_entity_id = public.active_company_id())
  );

-- ── 4. The portal (service role only) ───────────────────────────────────
-- The token decides whose content this is. Nothing in the request names an
-- affiliate or a company.
create or replace function public.affiliate_portal_content_start(
  p_token_hash text, p_kind text, p_link_url text, p_caption text, p_file_type text, p_file_bytes bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok  record;
  v_id   uuid := gen_random_uuid();
  v_ext  text;
  v_open integer;
  v_cap  text := nullif(left(btrim(coalesce(p_caption, '')), 500), '');
  v_type text := lower(btrim(coalesce(p_file_type, '')));
  v_link text := btrim(coalesce(p_link_url, ''));
begin
  select t.company_entity_id, t.program_id, t.affiliate_id into v_tok
    from public.affiliate_access_tokens t
    join public.affiliates a
      on a.id = t.affiliate_id and a.company_entity_id = t.company_entity_id and a.program_id = t.program_id
   where t.token_hash = p_token_hash
     and t.purpose = 'portal'
     and t.revoked_at is null
     and t.expires_at > now()
     and a.status = 'active';
  if not found then
    raise exception 'affiliate_portal_content_start: link is not valid' using errcode = '42501';
  end if;

  -- A person reviews each one: not a flood.
  select count(*) into v_open from public.affiliate_content_submissions c
   where c.company_entity_id = v_tok.company_entity_id and c.affiliate_id = v_tok.affiliate_id
     and (c.state = 'submitted' or (c.state = 'uploading' and c.submitted_at > now() - interval '1 day'));
  if v_open >= 30 then
    raise exception 'affiliate_portal_content_start: you have 30 pieces waiting; wait for the brand to review them' using errcode = '22023';
  end if;

  if p_kind = 'link' then
    if v_link !~ '^https://[^\s"''<>]+$' or length(v_link) > 500 then
      raise exception 'affiliate_portal_content_start: paste a link that starts with https://' using errcode = '22023';
    end if;
    insert into public.affiliate_content_submissions
      (id, company_entity_id, program_id, affiliate_id, kind, link_url, caption, state)
    values (v_id, v_tok.company_entity_id, v_tok.program_id, v_tok.affiliate_id, 'link', v_link, v_cap, 'submitted');
    return jsonb_build_object('id', v_id, 'state', 'submitted');
  elsif p_kind = 'file' then
    v_ext := case v_type
      when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp'
      when 'image/gif' then 'gif' when 'image/heic' then 'heic'
      when 'video/mp4' then 'mp4' when 'video/quicktime' then 'mov' when 'video/webm' then 'webm' end;
    if v_ext is null then
      raise exception 'affiliate_portal_content_start: upload a photo or a video (JPEG, PNG, WebP, GIF, HEIC, MP4, MOV or WebM)' using errcode = '22023';
    end if;
    if p_file_bytes is null or p_file_bytes < 1 or p_file_bytes > 52428800 then
      raise exception 'affiliate_portal_content_start: files can be up to 50 MB' using errcode = '22023';
    end if;
    insert into public.affiliate_content_submissions
      (id, company_entity_id, program_id, affiliate_id, kind, storage_path, file_type, file_bytes, caption, state)
    values (v_id, v_tok.company_entity_id, v_tok.program_id, v_tok.affiliate_id, 'file',
            v_id::text || '/content.' || v_ext, v_type, p_file_bytes, v_cap, 'uploading');
    return jsonb_build_object('id', v_id, 'state', 'uploading', 'path', v_id::text || '/content.' || v_ext);
  end if;
  raise exception 'affiliate_portal_content_start: unknown kind' using errcode = '22023';
end;
$$;

revoke all on function public.affiliate_portal_content_start(text, text, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.affiliate_portal_content_start(text, text, text, text, text, bigint) to service_role;

-- The upload landed: only then does the brand see it. Replays answer the
-- same; a missing object leaves it uploading.
create or replace function public.affiliate_portal_content_finish(p_token_hash text, p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok record;
  v_c   record;
begin
  select t.company_entity_id, t.affiliate_id into v_tok
    from public.affiliate_access_tokens t
   where t.token_hash = p_token_hash and t.purpose = 'portal'
     and t.revoked_at is null and t.expires_at > now() and t.affiliate_id is not null;
  if not found then
    raise exception 'affiliate_portal_content_finish: link is not valid' using errcode = '42501';
  end if;
  select c.* into v_c from public.affiliate_content_submissions c
   where c.id = p_id and c.company_entity_id = v_tok.company_entity_id and c.affiliate_id = v_tok.affiliate_id
   for update;
  if not found then
    raise exception 'affiliate_portal_content_finish: no such upload' using errcode = '42501';
  end if;
  if v_c.state <> 'uploading' then
    return jsonb_build_object('id', v_c.id, 'state', v_c.state);
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'affiliate-content' and o.name = v_c.storage_path) then
    raise exception 'affiliate_portal_content_finish: the upload did not arrive; try again' using errcode = '22023';
  end if;
  update public.affiliate_content_submissions
     set state = 'submitted', submitted_at = now()
   where id = v_c.id;
  return jsonb_build_object('id', v_c.id, 'state', 'submitted');
end;
$$;

revoke all on function public.affiliate_portal_content_finish(text, uuid) from public, anon, authenticated;
grant execute on function public.affiliate_portal_content_finish(text, uuid) to service_role;

-- The affiliate's own pieces and what a picked one earns.
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
   where t.token_hash = p_token_hash and t.purpose = 'portal'
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
               'currency', c.currency, 'submitted_at', c.submitted_at, 'decided_at', c.decided_at)
             order by c.submitted_at desc)
        from (select * from public.affiliate_content_submissions c
               where c.company_entity_id = v_tok.company_entity_id and c.affiliate_id = v_tok.affiliate_id
                 and c.state <> 'uploading'
               order by c.submitted_at desc limit 100) c), '[]'::jsonb));
end;
$$;

revoke all on function public.affiliate_portal_content(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_content(text) to service_role;

-- ── 5. A manager decides ────────────────────────────────────────────────
-- Several at once, so a ticked queue is one press. 'use' with a bonus is a
-- money decision: it needs can_approve_affiliate_commissions(), the same gate
-- as a manual adjustment.
create or replace function public.affiliate_content_decide(p_ids uuid[], p_decision text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid := public.active_company_id();
  v_c       record;
  v_ledger  uuid;
  v_done    integer := 0;
  v_skipped integer := 0;
  v_paid    bigint := 0;
  v_memo    text;
begin
  if v_company is null or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_content_decide: only an Affiliate Studio manager can review content' using errcode = '42501';
  end if;
  if p_decision not in ('approve', 'use', 'decline') then
    raise exception 'affiliate_content_decide: unknown decision' using errcode = '22023';
  end if;

  for v_c in
    select c.*, p.content_bonus_cents as program_bonus, p.currency as program_currency
      from public.affiliate_content_submissions c
      join public.affiliate_programs p on p.id = c.program_id and p.company_entity_id = c.company_entity_id
     where c.id = any(coalesce(p_ids, '{}'::uuid[]))
       and c.company_entity_id = v_company
     for update of c
  loop
    -- A used piece is final: its bonus is on the ledger. Uploading is not
    -- the brand's yet. Approved may still be used or declined.
    if v_c.state in ('uploading', 'used') or (v_c.state = 'declined' and p_decision <> 'approve')
       or (v_c.state = 'approved' and p_decision = 'approve') then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if p_decision = 'use' then
      v_ledger := null;
      if coalesce(v_c.program_bonus, 0) > 0 then
        if not public.can_approve_affiliate_commissions() then
          raise exception 'affiliate_content_decide: paying a content bonus needs payout approval' using errcode = '42501';
        end if;
        v_memo := left('Content bonus: ' || coalesce(v_c.caption, case when v_c.kind = 'link' then v_c.link_url else 'upload' end), 300);
        insert into public.affiliate_commission_ledger
          (company_entity_id, program_id, affiliate_id, kind, source, amount_cents, currency, memo, created_by)
        values (v_company, v_c.program_id, v_c.affiliate_id, 'manual_adjustment', 'manual',
                v_c.program_bonus, v_c.program_currency, v_memo, auth.uid())
        returning id into v_ledger;
        v_paid := v_paid + v_c.program_bonus;
      end if;
      update public.affiliate_content_submissions
         set state = 'used', decided_at = now(), decided_by = auth.uid(),
             bonus_ledger_id = v_ledger,
             bonus_cents = case when v_ledger is null then null else v_c.program_bonus end,
             currency = case when v_ledger is null then null else v_c.program_currency end
       where id = v_c.id;
    else
      update public.affiliate_content_submissions
         set state = case when p_decision = 'approve' then 'approved' else 'declined' end,
             decided_at = now(), decided_by = auth.uid()
       where id = v_c.id;
    end if;
    v_done := v_done + 1;
  end loop;

  return jsonb_build_object('decided', v_done, 'skipped', v_skipped, 'bonus_cents', v_paid);
end;
$$;

revoke all on function public.affiliate_content_decide(uuid[], text) from public, anon;
grant execute on function public.affiliate_content_decide(uuid[], text) to authenticated;

select public.attach_stamp_company_entity_id_triggers();
