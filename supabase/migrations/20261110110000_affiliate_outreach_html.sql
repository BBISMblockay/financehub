-- Affiliate outreach sent by the person's own AI gets a proper email: the
-- company's name on top, the approved message, and the signup link as a
-- button instead of a long raw URL.
--
-- WHY. Blake, 2026-11-10, after the first live send (Claude + Gmail): the
-- signup link arrived as a long raw URL that Gmail had wrapped in a
-- google.com/url redirect; "more dressed up as silo affiliate brand and
-- button". silo_api_claim_outreach (20261110093000) returned plain text only,
-- so the AI could send nothing else.
--
-- WHAT CHANGES. Each claimed message gains "html": the SAME approved text,
-- HTML-escaped, with {signup_link} (or, for a template without it, the end of
-- the message) turned into a "See the program and join" button. The layout
-- matches affiliate-invite's own affiliate emails (renderMail). "body" is
-- unchanged and stays the plain-text alternative, so a mail tool without HTML
-- sends exactly what it sent before. Nothing else about claiming changes.
--
-- SAFETY. The message text is a person's approved draft: every character of
-- it is escaped, so a draft can never inject markup. Only the signup URL,
-- which SILO mints itself (https://get-silo.com/... plus 64 hex characters),
-- goes into an href, and it is escaped too. The helper is callable by nobody
-- but its definer caller.

-- ── 1. The HTML ───────────────────────────────────────────────────────────
create or replace function public.affiliate_outreach_html(p_brand text, p_body text, p_url text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_marker constant text := chr(1);   -- stripped from the draft first, so only the link position carries it
  v_body   text := replace(coalesce(p_body, ''), chr(1), '');
  v_esc    text;
  v_btn    text;
  v_paras  text := '';
  v_p      text;
  v_url    text := replace(replace(replace(replace(coalesce(p_url, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
  v_brand  text := replace(replace(replace(replace(coalesce(nullif(btrim(p_brand), ''), 'Affiliate program'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
begin
  v_body := replace(v_body, E'\r\n', E'\n');
  if position('{signup_link}' in v_body) > 0 then
    v_body := replace(v_body, '{signup_link}', c_marker);
  else
    v_body := v_body || E'\n\n' || c_marker;
  end if;
  v_esc := replace(replace(replace(replace(v_body, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
  v_btn := '</p><p style="margin:18px 0 18px"><a href="' || v_url
        || '" style="display:inline-block;background:#14181d;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;font-size:14px">See the program and join</a></p><p style="font-size:14px;line-height:1.55;margin:0 0 12px">';
  foreach v_p in array regexp_split_to_array(v_esc, E'\n\\s*\n') loop
    if btrim(v_p) = '' then continue; end if;
    v_paras := v_paras || '<p style="font-size:14px;line-height:1.55;margin:0 0 12px">'
            || replace(replace(btrim(v_p, E'\n'), E'\n', '<br>'), c_marker, v_btn) || '</p>' || E'\n';
  end loop;
  -- A button that ends a paragraph leaves an empty one behind; drop it.
  v_paras := replace(v_paras, '<p style="font-size:14px;line-height:1.55;margin:0 0 12px"></p>', '');
  return '<!doctype html><html><body style="margin:0;background:#f6f7f8;font-family:-apple-system,''Segoe UI'',system-ui,sans-serif;color:#14181d">'
    || '<div style="max-width:560px;margin:0 auto;padding:28px 16px">'
    || '<div style="font-weight:800;font-size:15px;margin-bottom:16px">' || v_brand || '</div>'
    || '<div style="background:#ffffff;border:1px solid #e2e6ea;border-radius:12px;padding:22px">' || E'\n'
    || v_paras
    || '</div>'
    || '<p style="font-size:12px;color:#77828d;margin-top:14px;line-height:1.5">' || v_brand || ' affiliate program, powered by SILO</p>'
    || '</div></body></html>';
end;
$$;

comment on function public.affiliate_outreach_html(text, text, text) is
  'Branded HTML for one approved affiliate outreach message: company name, the escaped message, and the signup link as a button where {signup_link} was (or at the end). Internal to silo_api_claim_outreach. 20261110110000.';

revoke all on function public.affiliate_outreach_html(text, text, text)
  from public, anon, authenticated, silo_integration, silo_revoked;

-- ── 2. Claim approved outreach, now with an HTML version ──────────────────
-- Re-stated from 20261110093000 (live, per the drift check) with THREE
-- changes: v_brand is read once from the company, each claimed message
-- carries "html" next to "body", and next_step says to send both.
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
begin
  v_grant   := public.silo_api_outreach_grant();
  v_company := v_grant.company_entity_id;
  v_user    := v_grant.user_id;
  v_app     := public.silo_api_app_name(v_grant.client_id, v_grant.app_key);
  select nullif(btrim(e.title), '') into v_brand from public.entities e where e.id = v_company;

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
        'html', public.affiliate_outreach_html(v_brand, v_d.body, v_link ->> 'url'),
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
  'MCP / developer API tool (outreach:send): claims up to 25 APPROVED email outreach drafts of one active affiliate program in the grant''s company, mints each a fresh 14-day signup link, and moves them to exported in a batch tagged with the connection ("Via <app>"), for the person''s own AI to send from their own mailbox. Suppressed recipients and active affiliates are skipped with a reason. Each claimed draft is one write against silo_api_write_cap(); the same idempotency key returns the same drafts with re-minted links and spends nothing. Each message comes as plain text (body) and branded HTML with a signup button (html). SILO sends nothing. 20261110093000, html 20261110110000.';

revoke all on function public.silo_api_claim_outreach(uuid, integer, text)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_claim_outreach(uuid, integer, text) to silo_integration;
