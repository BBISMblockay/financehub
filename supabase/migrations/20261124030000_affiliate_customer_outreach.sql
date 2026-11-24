-- Recruiting an existing customer: the same outreach flow Discovery uses,
-- entered from the Your Customers sub-tab.
--
-- Blake, 2026-11-24: "draft right away under the 'your customer' template
-- option in outreach. because thats same thing right like no matter where
-- they lead from discovery or customer routes, makes sense good call. skip do
-- not contacts yes as they don't want contact."
--
-- So there is NO second pipeline. A customer picked on that tab becomes an
-- ordinary `affiliate_prospects` row and an ordinary `affiliate_outreach_drafts`
-- row, and every step after that -- approve, send, mark sent, sign-up, welcome
-- email, code -- is the path that already exists and is not touched here.
-- This migration only makes room for them:
--
-- 1. `source = 'customer'`, so where they came from is recorded rather than
--    disguised as a search result. The badge, the counts and the queues all
--    read `source` already.
--
-- 2. A customer satisfies `affiliate_prospects_identifiable` by EMAIL. That
--    constraint demanded a profile URL or a handle, which is right for a
--    creator SILO found on the web and impossible for a person who has only
--    ever bought something: they have no channel yet -- finding it is what
--    the social scan will do later. An email is a stronger identifier than
--    either, so the constraint now accepts a contact_email as a third way to
--    be identifiable. It still refuses a row with none of the three, which is
--    what it exists for.
--
-- 3. A SECOND outreach template on the program, for customers. The creator
--    template pitches a stranger ("We found your channel through a search"),
--    which read to a customer of four years is worse than no message. Same
--    two columns, same {token} filling, same per-brand editing; a program
--    that has not written one gets SILO's default.
--
-- NOT CHANGED, deliberately: the do-not-contact enforcement. Blake asked for
-- suppressed customers to be skipped, and that is already absolute in the
-- database -- `affiliate_outreach_can_contact()` plus the trigger that
-- refuses to approve a draft for a suppressed value. The tab filters them out
-- before inserting so they never appear, which is convenience; the database
-- remains the boundary. Adding a second enforcement path here would be two
-- rules to keep in step.

-- 1 ── A customer is a recognised source.
alter table public.affiliate_prospects drop constraint if exists affiliate_prospects_source_check;
alter table public.affiliate_prospects add constraint affiliate_prospects_source_check
  check (source in ('serp', 'manual', 'csv_import', 'applied', 'ai_research', 'customer'));

-- 2 ── An email identifies a person as well as a channel does.
alter table public.affiliate_prospects drop constraint if exists affiliate_prospects_identifiable;
alter table public.affiliate_prospects add constraint affiliate_prospects_identifiable
  check (btrim(coalesce(profile_url, '')) <> ''
      or btrim(coalesce(handle, '')) <> ''
      or btrim(coalesce(contact_email, '')) <> '');

-- 3 ── The customer template, per program.
alter table public.affiliate_programs add column if not exists customer_outreach_subject text;
alter table public.affiliate_programs add column if not exists customer_outreach_body text;

comment on column public.affiliate_programs.customer_outreach_subject is
  'Subject for outreach to an existing CUSTOMER (Your Customers sub-tab), not a creator found on the web. Null means use SILO''s default. Same {token} filling as outreach_subject.';
comment on column public.affiliate_programs.customer_outreach_body is
  'Body for outreach to an existing CUSTOMER. Null means use SILO''s default. Must contain {signup_link} to be used, exactly as outreach_body must -- a message with no way to join is not a message.';

-- 4 ── One prospect per customer per program, enforced by the DATABASE.
--
-- `affiliate_prospects_identity` cannot do this job: its key is
-- `coalesce(nullif(btrim(profile_url),''), platform || ':' || btrim(handle))`,
-- and a customer has neither a profile URL nor a handle until the social scan
-- finds one -- so the expression is NULL, and a unique index permits NULLs
-- without limit. Two adds of the same customer therefore made two prospects
-- and two drafts, which is two signup links to one person. The browser's own
-- duplicate check reads only the newest 500 prospects it has loaded, so it
-- cannot be the guard either: an older customer, or a second tab, slips past
-- it. This index is the guard; the browser's check only spares a round trip.
--
-- Partial on `source = 'customer'` so a creator's row is untouched, and no
-- existing row can collide: this source did not exist until this migration.
create unique index if not exists affiliate_prospects_customer_identity
  on public.affiliate_prospects (company_entity_id, program_id, lower(btrim(contact_email)))
  where source = 'customer' and btrim(coalesce(contact_email, '')) <> '';

comment on index public.affiliate_prospects_customer_identity is
  'One customer prospect per email per program. A customer has no handle or profile URL, so affiliate_prospects_identity keys them all as NULL and cannot deduplicate them.';

select public.refresh_chat_schema_catalog();
