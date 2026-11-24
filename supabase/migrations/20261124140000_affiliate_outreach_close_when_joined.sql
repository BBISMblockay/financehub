-- Outreach stops the moment somebody is in the program.
--
-- Blake, 2026-11-24: a creator was DM'd outside SILO, nobody marked the
-- message sent, and the person was then invited and became an affiliate --
-- while their recruiting draft sat open in another program's "To approve",
-- one press away from being sent to somebody who had already joined.
--
-- Signing up already closed SOME of those rows: affiliate_portal_accept_terms
-- (20261110086000) moves 'exported', 'sent' and 'replied' to 'signed_up' when
-- the affiliate row carries from_prospect_id. Three gaps left a draft open:
--   * 'draft' and 'approved' were not touched at all, which is exactly the
--     state a message sits in before anybody has done anything with it;
--   * nothing closed anything at INVITE time, only on terms acceptance;
--   * the only link was from_prospect_id, so a person added by email, by
--     import or from another program's prospect row matched nothing.
--
-- So the rule moves off the signup path and onto the membership itself: while
-- a person holds a live membership in this company, their open outreach is
-- closed, however they got there. A membership is the brand's own decision to
-- work with them, which is a better answer than a recruiting message.
--
-- 'signed_up' is the existing terminal state for "they are in the program
-- now"; no new state, no CHECK change, and the row still reads in Records
-- under Sent and outcomes with its note. The guard is re-created to keep
-- 'signed_up' out of the suppression check for the same reason 20261124000000
-- took the outcomes out: recording that somebody joined is not contacting
-- them, and a suppressed person who joins must not make the invite fail.

begin;

-- ── 1. Closing a draft because they joined is not contacting anyone ──────

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
  -- that was already sent (20261124000000). 'signed_up' joins them here:
  -- it is written by affiliate_outreach_close_when_joined() inside the
  -- transaction that creates the membership, so leaving it in this check
  -- would make inviting a suppressed person fail at the invite.
  if new.state in ('approved','exported','sent')
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
  'A draft may not be APPROVED, exported or sent for a recipient on the suppression list, or against a suppressed prospect. The terminal outcomes (declined, bounced, replied) record what a sent message brought back, and signed_up records that the person joined -- none of them is a decision to contact anybody. (20261124140000)';

-- ── 2. A live membership closes that person's open outreach ──────────────

create or replace function public.affiliate_outreach_close_when_joined()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := public.affiliate_contact_key(new.contact_email);
begin
  -- 'terminated' and a membership that never started are not a reason to stop
  -- recruiting somebody; every live one is.
  if new.status not in ('invited','pending_terms','active','paused') then
    return null;
  end if;
  -- Company-wide, not program-wide, and deliberately: a cold recruiting
  -- message to somebody who is already an affiliate of this brand is wrong
  -- whichever program drafted it. Bringing an existing affiliate into a
  -- second program is an invite, which this does not touch.
  update public.affiliate_outreach_drafts d
     set state = 'signed_up',
         outcome_note = coalesce(nullif(btrim(coalesce(d.outcome_note, '')), ''),
                                 'closed: already an affiliate of this brand'),
         updated_at = now()
   where d.company_entity_id = new.company_entity_id
     and d.state in ('draft','approved','exported')
     and (
       (new.from_prospect_id is not null and d.prospect_id = new.from_prospect_id)
       or (v_key is not null and public.affiliate_contact_key(d.recipient_email) = v_key)
       or (v_key is not null and exists (
             select 1 from public.affiliate_prospects p
              where p.id = d.prospect_id
                and p.company_entity_id = d.company_entity_id
                and public.affiliate_contact_key(p.contact_email) = v_key))
     );
  return null;
end;
$$;

revoke execute on function public.affiliate_outreach_close_when_joined() from public, anon, authenticated;

comment on function public.affiliate_outreach_close_when_joined() is
  'While a person holds a live membership in this company, their open outreach drafts (draft, approved, exported) are closed as signed_up, matched by the prospect the membership came from, by the draft''s own recipient address and by the prospect''s address. Company-wide on purpose: a recruiting message to an existing affiliate is wrong whichever program drafted it. (20261124140000)';

drop trigger if exists affiliate_outreach_close_when_joined_trg on public.affiliates;
create trigger affiliate_outreach_close_when_joined_trg
  after insert or update of status, contact_email, from_prospect_id on public.affiliates
  for each row execute function public.affiliate_outreach_close_when_joined();

-- ── 3. The ones already open ─────────────────────────────────────────────
-- Idempotent: a second run matches nothing, because the rows it closed are no
-- longer in a live state.

update public.affiliate_outreach_drafts d
   set state = 'signed_up',
       outcome_note = coalesce(nullif(btrim(coalesce(d.outcome_note, '')), ''),
                               'closed: already an affiliate of this brand'),
       updated_at = now()
 where d.state in ('draft','approved','exported')
   and exists (
     select 1 from public.affiliates a
      where a.company_entity_id = d.company_entity_id
        and a.status in ('invited','pending_terms','active','paused')
        and (
          (a.from_prospect_id is not null and a.from_prospect_id = d.prospect_id)
          or public.affiliate_contact_key(a.contact_email) = public.affiliate_contact_key(d.recipient_email)
          or exists (
               select 1 from public.affiliate_prospects p
                where p.id = d.prospect_id
                  and p.company_entity_id = d.company_entity_id
                  and public.affiliate_contact_key(p.contact_email) = public.affiliate_contact_key(a.contact_email))
        ));

commit;
