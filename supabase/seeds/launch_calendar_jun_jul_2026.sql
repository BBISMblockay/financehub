-- =============================================================================
-- Seed: Full marketing calendar Jun–Jul 2026 (from planning spreadsheet)
-- Run in Supabase SQL Editor. Cleanup: see supabase/seeds/README.md
-- =============================================================================

do $seed$
declare
  uid uuid;
  lid uuid;
begin
  select id into uid from auth.users order by created_at limit 1;
  if uid is null then
    raise exception 'No auth.users found. Sign in once or set uid in this script.';
  end if;

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
    '6432 Day Preview', '2026-06-03', '10:00:00', 'Filler Promo', 'Filler Promo',
    'planned', 'normal', 'not_reviewed', null, null,
    'seed:jun-jul-2026 · TZ: PST', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    '6432 Day', '2026-06-04', '00:00:00', 'Main Event', 'Main Event',
    'planned', 'high', 'not_reviewed', null, '2 emails, 2 sms, 32-64% off, 64 Items, free good eye teddy bear at $125',
    'seed:jun-jul-2026 · TZ: EST · Design due: 2026-01-05', uid
  ) returning id into lid;

  insert into public.launch_channel_items (
    launch_id, channel, item_title, scheduled_date, scheduled_time, status, notes, created_by
  ) values
    (lid, 'email', '6432 Day — email 1', '2026-06-04', '08:00:00', 'planned', 'seed:jun-jul-2026', uid),
    (lid, 'email', '6432 Day — email 2', '2026-06-04', '09:30:00', 'planned', 'seed:jun-jul-2026', uid),
    (lid, 'sms',   '6432 Day — SMS 1',   '2026-06-04', '10:00:00', 'planned', 'seed:jun-jul-2026', uid),
    (lid, 'sms',   '6432 Day — SMS 2',   '2026-06-04', '14:00:00', 'planned', 'seed:jun-jul-2026', uid);
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'FOD Refresh', '2026-06-07', '10:00:00', 'Soft Launch', 'Soft Launch',
    'planned', 'normal', 'not_reviewed', null, 'Only some items are launching: This Field, This Field Trunks, Build it 2.0, Classic Logo (Green), People Will Come, People Will Come (Light Grey), Heaven, This Field (Cream)

Create a landing page with shoppable products and content displays to promote our field of dreams store, barn at the movie site, MLB game',
    'seed:jun-jul-2026 · TZ: PST', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Father''s Day ICYMI #2', '2026-06-08', '10:00:00', 'Filler Promo', 'Filler Promo',
    'planned', 'normal', 'not_reviewed', null, 'Standard shipping cutoff, bucket black now available',
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
    'Hustle Club', '2026-06-11', '10:00:00', 'Main Event', 'Main Event',
    'planned', 'high', 'not_reviewed', 'Russ', null,
    'seed:jun-jul-2026 · TZ: PST · Design due: 2026-01-12', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'CWS Local', '2026-06-12', null, 'Other', 'Other',
    'planned', 'normal', 'not_reviewed', null, 'CWS - Local Promo',
    'seed:jun-jul-2026', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Father''s Day Coming Up', '2026-06-13', '10:00:00', 'Filler Promo', 'Filler Promo',
    'planned', 'normal', 'not_reviewed', null, 'Don''t guarantee delivery. Expedited shipping recommended, gift cards',
    'seed:jun-jul-2026 · TZ: PST', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'MLB SS Hoodies Restock + New', '2026-06-14', '10:00:00', 'Soft Launch', 'Soft Launch',
    'planned', 'normal', 'not_reviewed', null, null,
    'seed:jun-jul-2026 · TZ: PST', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Baseball Nation Five Panel and Dad Cap + Shorts', '2026-06-16', '10:00:00', 'Soft Launch', 'Soft Launch',
    'planned', 'normal', 'not_reviewed', null, 'Remarket Americana, may launch shorts if any are late',
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
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Gift Card Push - Father''s Day', '2026-06-19', null, 'Other', 'Other',
    'planned', 'normal', 'not_reviewed', null, null,
    'seed:jun-jul-2026', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Prime Day - Mystery Boxes', '2026-06-20', null, 'Other', 'Other',
    'planned', 'normal', 'not_reviewed', null, null,
    'seed:jun-jul-2026', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Father''s Day Holiday', '2026-06-21', '10:00:00', 'Filler Promo', 'Filler Promo',
    'planned', 'normal', 'not_reviewed', null, null,
    'seed:jun-jul-2026 · TZ: PST', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Bubbles and Doubles - Shorts, Tees, Caps', '2026-06-25', '10:00:00', 'Filler Promo', 'Filler Promo',
    'planned', 'normal', 'not_reviewed', null, 'also start marketing back to school in the evening',
    'seed:jun-jul-2026 · TZ: PST', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Ballplayer Box #2 Threshold', '2026-06-28', '10:00:00', 'Filler Promo', 'Filler Promo',
    'planned', 'normal', 'not_reviewed', null, null,
    'seed:jun-jul-2026 · TZ: PST', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Pin of Month', '2026-07-01', '00:00:00', 'Soft Launch', 'Soft Launch',
    'planned', 'normal', 'not_reviewed', null, null,
    'seed:jun-jul-2026 · TZ: EST', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Youth Caps', '2026-07-02', '10:00:00', 'Filler Promo', 'Filler Promo',
    'planned', 'normal', 'not_reviewed', null, 'Push for kids age 11 & under - size 7 head and smaller',
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
    'planned', 'normal', 'not_reviewed', null, '2 colors of new performance tee (youth), 1 adult (black)',
    'seed:jun-jul-2026 · TZ: PST · Design due: 2026-02-12', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'MLB Keychains, bracelets, pins', '2026-07-14', null, 'Soft Launch', 'Soft Launch',
    'planned', 'normal', 'not_reviewed', null, null,
    'seed:jun-jul-2026', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Back To School', '2026-07-16', null, 'Main Event', 'Main Event',
    'planned', 'high', 'not_reviewed', null, null,
    'seed:jun-jul-2026 · Design due: 2026-02-26', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'National Ice Cream Day', '2026-07-19', null, 'Filler Promo', 'Filler Promo',
    'planned', 'normal', 'not_reviewed', null, null,
    'seed:jun-jul-2026', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Quote Tees/Branded', '2026-07-26', null, 'Other', 'Other',
    'planned', 'normal', 'not_reviewed', 'Mark', null,
    'seed:jun-jul-2026', uid
  );
  insert into public.launch_calendar (
    title, launch_date, launch_time, launch_type, campaign_type, status,
    priority, launch_readiness, designer, details, notes, created_by
  ) values (
    'Back to school sale end', '2026-07-31', null, 'Promotion End', 'Promotion End',
    'planned', 'normal', 'not_reviewed', null, null,
    'seed:jun-jul-2026', uid
  );

  raise notice 'Seeded % launch rows for Jun–Jul 2026 (user %).', 27, uid;
end
$seed$;

select launch_date, launch_time, launch_type, designer, title
from public.launch_calendar
where notes like 'seed:jun-jul-2026%'
order by launch_date, title;
