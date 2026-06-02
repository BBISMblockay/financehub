-- =============================================================================
-- Seed: Marketing launch calendar (Jun–Jul 2026) from planning spreadsheet
-- Run in Supabase SQL Editor (after launch_calendar table exists).
--
-- Tags rows: notes = 'seed:jun-jul-2026'  →  easy cleanup (see seeds/README.md)
-- =============================================================================

do $seed$
declare
  uid uuid;
  lid uuid;
begin
  -- Prefer your account; replace with your uuid if needed:
  -- uid := '00000000-0000-0000-0000-000000000000'::uuid;
  select id into uid from auth.users order by created_at limit 1;
  if uid is null then
    raise exception 'No auth.users found. Sign in once, or set uid manually in this script.';
  end if;

  -- -------------------------------------------------------------------------
  -- June 2026
  -- -------------------------------------------------------------------------

  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Pin of the Month - June', '2026-06-01', '00:00:00', 'Soft Launch', 'Soft Launch',
    'planned', 'normal', 'not_reviewed', null, null,
    'seed:jun-jul-2026 · TZ: EST', uid
  );

  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    '6432 Day', '2026-06-04', '00:00:00', 'Main Event', 'Main Event',
    'planned', 'high', 'not_reviewed', null,
    '2 emails, 2 sms, 32-64% off, 64 items, free good eye teddy bear at $125',
    'seed:jun-jul-2026 · TZ: EST', uid
  ) returning id into lid;

  -- Example: channel initiatives live on their own dates (add more in UI or below)
  insert into public.launch_channel_items (
    launch_id, channel, item_title, scheduled_date, scheduled_time, status, notes, created_by
  ) values
    (lid, 'email', '6432 Day — email 1', '2026-06-04', '08:00:00', 'planned', 'seed:jun-jul-2026', uid),
    (lid, 'sms',   '6432 Day — SMS',     '2026-06-04', '09:00:00', 'planned', 'seed:jun-jul-2026', uid);

  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'FOD Refresh', '2026-06-07', '10:00:00', 'Soft Launch', 'Soft Launch',
    'planned', 'normal', 'not_reviewed', null,
    'Create a landing page with shoppable products and content displays to promote our field of dreams store, barn at the movie site, MLB game',
    'seed:jun-jul-2026 · TZ: PST', uid
  );

  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'CWS', '2026-06-09', '10:00:00', 'Main Event', 'Main Event',
    'planned', 'high', 'not_reviewed', 'Russ', null,
    'seed:jun-jul-2026 · TZ: PST · Design due: 2026-01-10', uid
  );

  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'CWS Local', '2026-06-12', null, null, 'Local Promo',
    'planned', 'normal', 'not_reviewed', null, 'CWS - Local Promo',
    'seed:jun-jul-2026', uid
  );

  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Baseball Nation Five Panel and Dad Cap + Shorts', '2026-06-16', '10:00:00', 'Soft Launch', 'Soft Launch',
    'planned', 'normal', 'not_reviewed', null,
    'Remarket Americana, may launch shorts if any are late',
    'seed:jun-jul-2026 · TZ: PST', uid
  );

  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Pitchers That Paint', '2026-06-18', '10:00:00', 'Main Event', 'Main Event',
    'planned', 'high', 'not_reviewed', 'Mark', null,
    'seed:jun-jul-2026 · TZ: PST · Design due: 2026-03-05', uid
  );

  -- -------------------------------------------------------------------------
  -- July 2026
  -- -------------------------------------------------------------------------

  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Youth Caps', '2026-07-02', '10:00:00', 'Filler Promo', 'Filler Promo',
    'planned', 'normal', 'not_reviewed', null,
    'Push for kids age 11 & under - size 7 head and smaller',
    'seed:jun-jul-2026 · TZ: PST', uid
  );

  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Dodgeball Legend', '2026-07-05', '10:00:00', 'Main Event', 'Main Event',
    'planned', 'high', 'not_reviewed', 'Russ', 'Youth Tee',
    'seed:jun-jul-2026 · TZ: PST · Design due: 2026-03-07', uid
  );

  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Banana Split', '2026-07-09', '10:00:00', 'Main Event', 'Main Event',
    'planned', 'high', 'not_reviewed', 'Russ', 'Youth Tee, Youth Shorts',
    'seed:jun-jul-2026 · TZ: PST · Design due: 2026-03-11', uid
  );

  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Performance Collection Refresh', '2026-07-12', '10:00:00', 'Soft Launch', 'Soft Launch',
    'planned', 'normal', 'not_reviewed', null,
    '2 colors of new performance tee (youth), 1 adult (black)',
    'seed:jun-jul-2026 · TZ: PST · Design due: 2026-02-12', uid
  );

  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Back to school sale end', '2026-07-31', null, 'Promotion End', 'Promotion End',
    'planned', 'normal', 'not_reviewed', null, null,
    'seed:jun-jul-2026', uid
  );

  raise notice 'Seeded launch_calendar for Jun–Jul 2026 (user %). Add more rows from spreadsheet as needed.', uid;
end
$seed$;

-- Verify
select launch_date, launch_time, launch_type, title
from public.launch_calendar
where notes like 'seed:jun-jul-2026%'
order by launch_date, title;
