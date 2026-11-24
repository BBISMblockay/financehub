-- Two fixes found reviewing the merges of 2026-11-21..23 (#1351), with the
-- outcome half of the outreach export fix in v2/affiliates/studio.js.
--
-- 1. A program-scoped manager could move a creator who is in programs they
--    were never given. `affiliate_person_email_follows()` (20261121230000)
--    runs SECURITY DEFINER and, on an email edit, rewrites the person's OTHER
--    memberships in the company and revokes the portal links mailed to the
--    old address. Neither step asked whether the editor may manage those
--    programs. The statement-level scope guard (20261121210000) does fire on
--    the cascaded writes, so the escalation stopped there -- but it stopped as
--    a raw 42501 from another table, after the editor's own row had already
--    changed in the same transaction, which reads as a bug rather than as a
--    refusal. Authorize the company-wide change BEFORE propagating it, and
--    say what is wrong.
--
-- 2. Recording an outcome is not contacting anyone.
--    `affiliate_outreach_drafts_guard()` (20261110084000) re-checks the
--    suppression list for every state at or past 'approved', which includes
--    the terminal outcomes. So "Asked to stop" -- which adds the person to the
--    do-not-contact list and then marks their sent message 'declined' --
--    always failed with a permission error at the second step, leaving the
--    suppression saved and the message stuck on 'sent'. The decision to
--    CONTACT (approved, exported, sent, signed_up) still checks the list;
--    declined, bounced and replied record what came back from a message that
--    was already sent.
--
-- Both are `create or replace` on existing functions: no table, policy or
-- grant changes, and re-running the file changes nothing. The third fix from
-- the same review is 20261124001000 (the customer lookup's index predicate),
-- kept separate because it touches a different feature entirely.

begin;

-- ── 1. A creator's address moves the whole person, so the whole person must
--       be the editor's to move ──────────────────────────────────────────

create or replace function public.affiliate_person_email_follows()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old text := public.affiliate_contact_key(old.contact_email);
  v_new text := public.affiliate_contact_key(new.contact_email);
  v_blocked uuid;
begin
  if v_old is null or v_new is null or v_old = v_new then
    return null;
  end if;
  -- A scoped manager (one whose every grant names a program) may only make
  -- this change when every membership that follows, and every portal link
  -- that is revoked, is inside the programs they were given. A caller with no
  -- auth.uid() -- the service role, a cron, a sync, an edge function -- is
  -- never scoped and is never checked, exactly as in
  -- affiliate_program_scope_guard().
  if auth.uid() is not null and public.affiliate_manager_scoped() then
    select a.program_id into v_blocked
      from public.affiliates a
     where a.company_entity_id = new.company_entity_id
       and a.id <> new.id
       and public.affiliate_contact_key(a.contact_email) = v_old
       and not public.affiliate_visible_program(a.program_id)
     limit 1;
    if v_blocked is null then
      select t.program_id into v_blocked
        from public.affiliate_access_tokens t
       where t.company_entity_id = new.company_entity_id
         and t.mailed_to_hash = v_old
         and t.purpose = 'portal'
         and t.revoked_at is null
         and not public.affiliate_visible_program(t.program_id)
       limit 1;
    end if;
    if v_blocked is not null then
      raise exception 'affiliate_program_scope: this creator is also in a program you were not given, and an address is one person across programs -- ask someone who manages all of their programs to change it'
        using errcode = '42501';
    end if;
  end if;
  -- A portal link is bound to the address it was mailed to, and
  -- affiliate_portal_brands() requires that address to STILL be this
  -- affiliate's, so the link stops working the moment the address changes.
  -- That check is deliberate -- it is what stops an edit after the mail from
  -- walking a token into another company -- so this does not loosen it. It
  -- records the revocation instead of leaving a link that silently fails, and
  -- the page then says to send a new one.
  update public.affiliate_access_tokens t
     set revoked_at = now()
   where t.company_entity_id = new.company_entity_id
     and t.mailed_to_hash = v_old
     and t.purpose = 'portal'
     and t.revoked_at is null;
  -- And their other memberships in this company follow the new address, or the
  -- brand switcher -- which finds them by that same key -- splits one person
  -- into two who each see half their brands. Terminates: the cascaded rows
  -- fire this trigger with the same old key and find nothing left under it.
  update public.affiliates a
     set contact_email = new.contact_email
   where a.company_entity_id = new.company_entity_id
     and a.id <> new.id
     and public.affiliate_contact_key(a.contact_email) = v_old;
  return null;
end;
$$;

comment on function public.affiliate_person_email_follows() is
  'A creator''s address is their identity: changing it on one membership moves their other memberships in the same company and revokes the portal links mailed to the old address, which could no longer work anyway. A program-scoped manager may only make that change where every membership and link it touches is in a program they were given (20261124000000). (20261121230000)';

commit;

begin;

-- ── 2. The suppression list gates contacting, not recording an outcome ───

create or replace function public.affiliate_outreach_drafts_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prospect record;
begin
  -- 'declined', 'bounced' and 'replied' are what came BACK from a message
  -- that was already sent; they are deliberately not here. Blocking them
  -- made "they asked to stop" impossible to record, because the first half of
  -- that action is adding the person to the list this very check reads.
  if new.state in ('approved','exported','sent','signed_up')
     and (tg_op = 'INSERT' or old.state = 'draft' or old.state is distinct from new.state)
  then
    if not public.affiliate_outreach_can_contact(
         new.company_entity_id, new.program_id,
         new.recipient_email, new.recipient_handle, null)
    then
      raise exception 'affiliate_outreach_drafts: this recipient is on the suppression list for this program'
        using errcode = '42501';
    end if;
  end if;

  if new.state in ('approved','exported') then
    select p.status into v_prospect
      from public.affiliate_prospects p
     where p.id = new.prospect_id and p.company_entity_id = new.company_entity_id;
    if v_prospect.status = 'suppressed' then
      raise exception 'affiliate_outreach_drafts: the prospect is suppressed'
        using errcode = '42501';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.affiliate_outreach_drafts_guard() from public, anon, authenticated;

comment on function public.affiliate_outreach_drafts_guard() is
  'A draft may not be APPROVED, exported, sent or signed up for a recipient on the suppression list, or against a suppressed prospect. The terminal outcomes (declined, bounced, replied) record what a sent message brought back and are not a decision to contact anyone. (20261124000000)';

commit;

