-- Company logo: owners upload one in Settings -> Company, and the affiliate
-- outreach email shows it in place of the initial badge.
--
-- WHY. Blake, 2026-11-10: "which begs us uploading company logo in workspace
-- settings to implement into outreach and portals." SILO had no company logo;
-- the email and the join page drew the company's first letter instead.
--
-- WHAT CHANGES.
--   1. company_settings.logo_url, nullable. A CHECK holds it to an https
--      address of an object in THIS company's own folder of the company-logos
--      bucket on a Supabase host, so a stored value can never point an email
--      image at an arbitrary server (a tracking pixel) or at another
--      company's logo. The existing
--      company_settings UPDATE policy (owner_admin of the active company)
--      decides who may set it.
--   2. A public company-logos bucket (PNG, JPEG, WebP only -- no SVG, which
--      can carry script; 1 MB). Public READ, because an email image and the
--      unauthenticated join and portal pages must load it. Writes only by an
--      owner_admin of the active company, only into that company's folder
--      ({company_entity_id}/logo-<ms>.<ext>; the timestamp in the name keeps
--      a replaced logo from being served from a mail client's cache).
--   3. affiliate_outreach_html gains a 4th argument, the logo address; the
--      3-argument form stays and passes null (no defaults, so no ambiguous
--      call). The badge cell becomes the logo image when one is set.
--   4. silo_api_claim_outreach, re-stated from 20261110110000 (live; the
--      live body differs only by CRLF line endings) with two changes: it
--      reads the company's logo_url once and passes it to the HTML.
-- Nothing is backfilled; a company without a logo looks exactly as today.

-- ── 1. The column ─────────────────────────────────────────────────────────
alter table public.company_settings add column if not exists logo_url text;

alter table public.company_settings drop constraint if exists company_settings_logo_url_check;
alter table public.company_settings add constraint company_settings_logo_url_check check (
  logo_url is null or (
    length(logo_url) <= 500
    and logo_url ~ ('^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/company-logos/'
                    || company_entity_id::text || '/logo-[0-9]{10,16}\.(png|jpg|jpeg|webp)$')
  ));

comment on column public.company_settings.logo_url is
  'Public address of the company logo in the company-logos bucket, set from Settings -> Company by an owner. Shown in affiliate outreach email and the affiliate join and portal pages. NULL means no logo: the initial badge is shown. 20261110140000.';

-- ── 2. The bucket ─────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('company-logos', 'company-logos', true, 1048576, array['image/png', 'image/jpeg', 'image/jpg', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists company_logos_public_read on storage.objects;
create policy company_logos_public_read
  on storage.objects for select
  using (bucket_id = 'company-logos');

drop policy if exists company_logos_owner_insert on storage.objects;
create policy company_logos_owner_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'company-logos'
    and (storage.foldername(name))[1] = public.active_company_id()::text
    and public.is_owner_admin_of_active_company());

drop policy if exists company_logos_owner_update on storage.objects;
create policy company_logos_owner_update
  on storage.objects for update to authenticated
  using (bucket_id = 'company-logos'
    and (storage.foldername(name))[1] = public.active_company_id()::text
    and public.is_owner_admin_of_active_company())
  with check (bucket_id = 'company-logos'
    and (storage.foldername(name))[1] = public.active_company_id()::text
    and public.is_owner_admin_of_active_company());

drop policy if exists company_logos_owner_delete on storage.objects;
create policy company_logos_owner_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'company-logos'
    and (storage.foldername(name))[1] = public.active_company_id()::text
    and public.is_owner_admin_of_active_company());

-- ── 3. The email HTML, with the logo ──────────────────────────────────────
-- Re-stated from 20261110130000 with the logo argument; otherwise identical.
create or replace function public.affiliate_outreach_html(p_brand text, p_body text, p_url text, p_logo text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_marker constant text := chr(1);   -- stripped from the draft first, so only the link position carries it
  c_p      constant text := '<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#14181d">';
  v_body   text := replace(coalesce(p_body, ''), chr(1), '');
  v_esc    text;
  v_btn    text;
  v_paras  text := '';
  v_p      text;
  v_url    text := replace(replace(replace(replace(coalesce(p_url, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
  v_name   text := coalesce(nullif(btrim(p_brand), ''), 'Affiliate program');
  v_brand  text;
  v_init   text;
  v_logo   text;
  v_mark   text;
begin
  v_brand := replace(replace(replace(replace(v_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
  v_init  := replace(replace(replace(replace(upper(left(v_name, 1)), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
  -- The logo is used only when it is an https address in a Supabase company-logos
  -- bucket (the company_settings CHECK already guarantees that for stored
  -- values); anything else falls back to the initial badge.
  if p_logo ~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/company-logos/[0-9a-f-]{36}/logo-[0-9]{10,16}\.(png|jpg|jpeg|webp)$' then
    v_logo := replace(replace(replace(replace(p_logo, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
  end if;
  v_mark := case when v_logo is not null
    then '<td height="36" valign="middle" style="height:36px"><img src="' || v_logo || '" height="36" alt="' || v_brand || '" style="display:block;height:36px;width:auto;max-width:180px;border:0;border-radius:6px"></td>'
    else '<td width="32" height="32" align="center" bgcolor="#14181d" style="background:#14181d;border-radius:8px;color:#ffffff;font-weight:700;font-size:15px;width:32px;height:32px">' || v_init || '</td>'
  end;
  v_body := replace(v_body, E'\r\n', E'\n');
  if position('{signup_link}' in v_body) > 0 then
    v_body := replace(v_body, '{signup_link}', c_marker);
  else
    v_body := v_body || E'\n\n' || c_marker;
  end if;
  v_esc := replace(replace(replace(replace(v_body, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
  v_btn := '</p>'
    || '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 10px"><tr>'
    || '<td bgcolor="#14181d" style="background:#14181d;border-radius:8px;padding:0">'
    || '<a href="' || v_url || '" target="_blank" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:8px">See the program and join &rarr;</a>'
    || '</td></tr></table>'
    || '<p style="margin:0 0 18px;font-size:12px;line-height:1.5;color:#77828d">Or open this link: '
    || '<a href="' || v_url || '" target="_blank" style="color:#2f5fd0;word-break:break-all">' || v_url || '</a></p>'
    || c_p;
  foreach v_p in array regexp_split_to_array(v_esc, E'\n\\s*\n') loop
    if btrim(v_p) = '' then continue; end if;
    v_paras := v_paras || c_p || replace(replace(btrim(v_p, E'\n'), E'\n', '<br>'), c_marker, v_btn) || '</p>' || E'\n';
  end loop;
  -- A button that ends a paragraph leaves an empty one behind; drop it.
  v_paras := replace(v_paras, c_p || '</p>', '');
  return '<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f5f7" style="background:#f4f5f7"><tr><td align="center" style="padding:28px 12px">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:-apple-system,''Segoe UI'',Roboto,Helvetica,Arial,sans-serif">'
    || '<tr><td style="padding:0 4px 14px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
    || v_mark
    || '<td style="padding-left:10px;font-weight:700;font-size:16px;color:#14181d">' || v_brand || '</td>'
    || '</tr></table></td></tr>'
    || '<tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid #e2e6ea;border-radius:12px;padding:26px 26px 12px">' || E'\n'
    || v_paras
    || '</td></tr>'
    || '<tr><td style="padding:14px 4px 0;font-size:12px;line-height:1.5;color:#77828d">' || v_brand || ' affiliate program, powered by SILO</td></tr>'
    || '</table></td></tr></table></body></html>';
end;
$$;


comment on function public.affiliate_outreach_html(text, text, text, text) is
  'Branded HTML for one approved affiliate outreach message: the company logo (or its initial) and name, the escaped message, an email-safe table button where {signup_link} was (or at the end) with the link also shown as text under it. Internal to silo_api_claim_outreach. 20261110110000, button 20261110130000, logo 20261110140000.';

revoke all on function public.affiliate_outreach_html(text, text, text, text)
  from public, anon, authenticated, silo_integration, silo_revoked;

-- The 3-argument form stays for anything that still calls it, without a logo.
create or replace function public.affiliate_outreach_html(p_brand text, p_body text, p_url text)
returns text
language sql
immutable
set search_path = ''
as $$ select public.affiliate_outreach_html(p_brand, p_body, p_url, null::text) $$;

revoke all on function public.affiliate_outreach_html(text, text, text)
  from public, anon, authenticated, silo_integration, silo_revoked;

-- ── 4. Claim approved outreach, now passing the logo ──────────────────────
-- Re-stated from 20261110110000 with two changes: v_logo is read once from
-- company_settings and passed as the 4th argument of affiliate_outreach_html.
create or replace function public.silo_api_claim_outreach(
  p_program_id      uuid default null,
  p_limit           integer default 10,
  p_idempotency_key text default null)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant    public.silo_api_grants;
  v_company  uuid;
  v_user     uuid;
  v_app      text;
  v_key      text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_program  uuid;
  v_batch    uuid;
  v_replay   boolean := false;
  v_used     integer;
  v_room     integer;
  v_limit    integer;
  v_d        record;
  v_link     json;
  v_claimed  jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_n        integer := 0;
  v_brand    text;
  v_logo     text;
begin
  v_grant   := public.silo_api_outreach_grant();
  v_company := v_grant.company_entity_id;
  v_user    := v_grant.user_id;
  v_app     := public.silo_api_app_name(v_grant.client_id, v_grant.app_key);
  select nullif(btrim(e.title), '') into v_brand from public.entities e where e.id = v_company;
  -- The company's own logo, when its owner uploaded one (20261110140000).
  select cs.logo_url into v_logo from public.company_settings cs where cs.company_entity_id = v_company;

  if length(coalesce(v_key, '')) > 100 then
    raise exception 'invalid_idempotency_key: keep it under 100 characters'
      using errcode = 'check_violation';
  end if;

  -- A retry with the same key is the same claim: hand back what it claimed,
  -- with fresh links, and spend nothing.
  if v_key is not null then
    select b.id into v_batch
      from public.affiliate_outreach_batches b
     where b.created_by_grant_id = v_grant.id and b.idempotency_key = v_key;
    v_replay := v_batch is not null;
  end if;

  if not v_replay then
    if p_program_id is not null then
      select pr.id into v_program
        from public.affiliate_programs pr
       where pr.id = p_program_id and pr.company_entity_id = v_company;
      if v_program is null then
        raise exception 'unknown_program: that affiliate program is not in this company'
          using errcode = 'check_violation';
      end if;
      if not exists (select 1 from public.affiliate_programs pr
                      where pr.id = v_program and pr.status = 'active') then
        raise exception 'program_not_active: outreach goes out only for an active program'
          using errcode = 'check_violation';
      end if;
    else
      -- One program per claim, so one batch per claim: the program of the
      -- longest-waiting approved draft.
      select d.program_id into v_program
        from public.affiliate_outreach_drafts d
        join public.affiliate_programs pr on pr.id = d.program_id and pr.company_entity_id = v_company
       where d.company_entity_id = v_company
         and d.state = 'approved' and d.channel = 'email'
         and btrim(coalesce(d.recipient_email, '')) <> ''
         and pr.status = 'active'
       order by d.approved_at nulls last, d.id
       limit 1;
    end if;

    if v_program is null then
      return json_build_object(
        'claimed', '[]'::json, 'skipped', '[]'::json, 'replayed', false,
        'note', 'No approved email outreach is waiting. A person approves drafts in Affiliate Studio first.');
    end if;

    select count(*) into v_used
      from public.silo_api_writes w
     where w.grant_id = v_grant.id
       and w.created_at > now() - interval '1 day';
    v_room := public.silo_api_write_cap() - v_used;
    if v_room <= 0 then
      raise exception 'write_cap_reached: this connection has used its % writes for today', public.silo_api_write_cap()
        using errcode = 'check_violation';
    end if;
    v_limit := least(greatest(coalesce(p_limit, 10), 1), 25, v_room);

    insert into public.affiliate_outreach_batches
      (company_entity_id, program_id, channel, note, row_count, exported_at, exported_by,
       created_by, created_by_grant_id, created_by_app, idempotency_key)
    values
      (v_company, v_program, 'email', 'Via ' || v_app || ', to send from the approver''s own mailbox', 0, now(), v_user,
       v_user, v_grant.id, v_app, v_key)
    on conflict (created_by_grant_id, idempotency_key)
      where created_by_grant_id is not null and idempotency_key is not null
      do nothing
    returning id into v_batch;

    if v_batch is null then
      -- A parallel call with the same key won the insert.
      select b.id into v_batch
        from public.affiliate_outreach_batches b
       where b.created_by_grant_id = v_grant.id and b.idempotency_key = v_key;
      v_replay := true;
    end if;
  end if;

  if v_replay then
    select b.program_id into v_program from public.affiliate_outreach_batches b where b.id = v_batch;
  end if;

  for v_d in
    select d.id, d.prospect_id, d.recipient_email, d.recipient_handle, d.subject, d.body,
           p.handle, p.profile_url
      from public.affiliate_outreach_drafts d
      join public.affiliate_prospects p on p.id = d.prospect_id and p.company_entity_id = v_company
     where d.company_entity_id = v_company
       and d.program_id = v_program
       and d.channel = 'email'
       and btrim(coalesce(d.recipient_email, '')) <> ''
       and case when v_replay
             then d.batch_id = v_batch and d.state = 'exported'
             else d.state = 'approved'
           end
     order by d.approved_at nulls last, d.id
     for update of d skip locked
  loop
    -- Stop at the limit by what was CLAIMED, not by rows looked at: a
    -- suppressed recipient at the head of the queue must not use up a claim.
    exit when not v_replay and v_n >= v_limit;
    exit when v_replay and v_n >= 25;
    begin
      if not public.affiliate_outreach_can_contact(
           v_company, v_program, v_d.recipient_email, v_d.handle, v_d.profile_url) then
        raise exception 'suppressed: this recipient asked not to be contacted';
      end if;

      v_link := public.affiliate_outreach_mint_signup(
        v_company, v_program, v_d.prospect_id, lower(btrim(v_d.recipient_email)), v_user);

      update public.affiliate_outreach_drafts
         set state = 'exported', batch_id = v_batch, exported_at = coalesce(exported_at, now()),
             token_id = (v_link ->> 'token_id')::uuid, changed_by = v_user
       where id = v_d.id;

      if not v_replay then
        insert into public.silo_api_writes
          (company_entity_id, grant_id, user_id, via, kind, target_id)
        values
          (v_company, v_grant.id, v_user, 'app', 'outreach_claim', v_d.id);
      end if;

      v_n := v_n + 1;
      v_claimed := v_claimed || jsonb_build_object(
        'draft_id', v_d.id,
        'to', lower(btrim(v_d.recipient_email)),
        'subject', v_d.subject,
        'body', case when position('{signup_link}' in coalesce(v_d.body, '')) > 0
                  then replace(v_d.body, '{signup_link}', v_link ->> 'url')
                  else coalesce(v_d.body, '') || E'\n\n' || (v_link ->> 'url') end,
        'html', public.affiliate_outreach_html(v_brand, v_d.body, v_link ->> 'url', v_logo),
        'signup_url', v_link ->> 'url',
        'signup_url_expires_at', v_link ->> 'expires_at');
    exception when others then
      -- One bad draft does not sink the rest; it stays approved (or, on a
      -- replay, exported) and the reason goes back to the bot.
      if jsonb_array_length(v_skipped) < 25 then
        v_skipped := v_skipped || jsonb_build_object(
          'draft_id', v_d.id, 'reason', split_part(sqlerrm, ':', 1), 'detail', sqlerrm);
      end if;
    end;
  end loop;

  if not v_replay then
    update public.affiliate_outreach_batches set row_count = v_n where id = v_batch;
  end if;

  return json_build_object(
    'batch_id', v_batch,
    'program_id', v_program,
    'replayed', v_replay,
    'claimed', v_claimed,
    'skipped', v_skipped,
    'via', v_app,
    'next_step', case when v_n > 0 then
      'Send each message exactly as written, one email per recipient, from the person''s own mailbox, to the "to" address only. '
      || 'Send "html" as the HTML body and "body" as the plain-text body of the same email (for Gmail: htmlBody and body), so the signup link shows as a button. '
      || 'Then call mark_outreach_sent with its draft_id and the sent message''s id. Do not send to anyone not listed here, '
      || 'and do not add recipients, BCCs or follow-ups. A message you do not send stays in Affiliate Studio as exported.'
      end);
end;
$$;

comment on function public.silo_api_claim_outreach(uuid, integer, text) is
  'MCP / developer API tool (outreach:send): claims up to 25 APPROVED email outreach drafts of one active affiliate program in the grant''s company, mints each a fresh 14-day signup link, and moves them to exported in a batch tagged with the connection ("Via <app>"), for the person''s own AI to send from their own mailbox. Suppressed recipients and active affiliates are skipped with a reason. Each claimed draft is one write against silo_api_write_cap(); the same idempotency key returns the same drafts with re-minted links and spends nothing. Each message comes as plain text (body) and branded HTML with a signup button (html). SILO sends nothing. 20261110093000, html 20261110110000, logo 20261110140000.';

revoke all on function public.silo_api_claim_outreach(uuid, integer, text)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_claim_outreach(uuid, integer, text) to silo_integration;

select public.refresh_chat_schema_catalog();
