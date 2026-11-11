-- Affiliate Studio: a rep's own photo, and the program's own outreach message.
--
-- 1. affiliates.photo_url / photo_hidden. A rep who joined manages their photo
--    in the portal (affiliate-portal `photo` action, which writes with the
--    service role only after the portal token resolves to this affiliate).
--    What a card shows:
--      photo_hidden            -> no photo (initials), whatever else exists
--      photo_url               -> the rep's own upload
--      neither                 -> the photo SILO found for them as a prospect
--    So a rep who never touches it keeps the photo research found, and one
--    who removes it is not handed the found photo back.
--
-- 2. affiliate_programs.outreach_subject / outreach_body. The wording every
--    NEW draft starts from. NULL means SILO's built-in message. The body must
--    keep {signup_link}, which is the creator's only way to join.
--
-- Additive and idempotent. No data is changed.

alter table public.affiliates
  add column if not exists photo_url text,
  add column if not exists photo_hidden boolean not null default false;

alter table public.affiliates drop constraint if exists affiliates_photo_url_https;
alter table public.affiliates add constraint affiliates_photo_url_https
  check (photo_url is null or (char_length(photo_url) <= 2000 and photo_url ~ '^https://[^[:space:]"''<>()\\]+$'));

alter table public.affiliate_programs
  add column if not exists outreach_subject text,
  add column if not exists outreach_body text;

alter table public.affiliate_programs drop constraint if exists affiliate_programs_outreach_message;
alter table public.affiliate_programs add constraint affiliate_programs_outreach_message
  check (
    (outreach_subject is null or char_length(btrim(outreach_subject)) between 1 and 200)
    and (outreach_body is null or (char_length(outreach_body) <= 5000 and position('{signup_link}' in outreach_body) > 0))
  );

comment on column public.affiliates.photo_url is
  'The rep''s own photo (SILO storage), set from the affiliate portal. NULL: show the photo found for them as a prospect.';
comment on column public.affiliates.photo_hidden is
  'The rep removed their photo: show initials, never the found photo.';
comment on column public.affiliate_programs.outreach_subject is
  'Subject every new outreach draft starts from. NULL: SILO''s built-in subject.';
comment on column public.affiliate_programs.outreach_body is
  'Message every new outreach draft starts from; must contain {signup_link}. NULL: SILO''s built-in message.';

-- Ask SILO's schema map picks up the new columns.
select public.refresh_chat_schema_catalog();
