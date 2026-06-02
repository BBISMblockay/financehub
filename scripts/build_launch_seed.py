#!/usr/bin/env python3
"""Generate launch_calendar_jun_jul_2026.sql from marketing spreadsheet rows."""
from pathlib import Path

ROWS = [
    ("2026-06-01", "Pin of the Month - June", "Soft Launch", None, None, None, "00:00:00", "EST"),
    ("2026-06-03", "6432 Day Preview", "Filler Promo", None, None, None, "10:00:00", "PST"),
    ("2026-06-04", "6432 Day", "Main Event", None, "2026-01-05", "2 emails, 2 sms, 32-64% off, 64 Items, free good eye teddy bear at $125", "00:00:00", "EST"),
    ("2026-06-07", "FOD Refresh", "Soft Launch", None, None, """Only some items are launching: This Field, This Field Trunks, Build it 2.0, Classic Logo (Green), People Will Come, People Will Come (Light Grey), Heaven, This Field (Cream)

Create a landing page with shoppable products and content displays to promote our field of dreams store, barn at the movie site, MLB game""", "10:00:00", "PST"),
    ("2026-06-08", "Father's Day ICYMI #2", "Filler Promo", None, None, "Standard shipping cutoff, bucket black now available", "10:00:00", "PST"),
    ("2026-06-09", "CWS", "Main Event", "Russ", "2026-01-10", None, "10:00:00", "PST"),
    ("2026-06-11", "Hustle Club", "Main Event", "Russ", "2026-01-12", None, "10:00:00", "PST"),
    ("2026-06-12", "CWS Local", None, None, None, "CWS - Local Promo", None, None),
    ("2026-06-13", "Father's Day Coming Up", "Filler Promo", None, None, "Don't guarantee delivery. Expedited shipping recommended, gift cards", "10:00:00", "PST"),
    ("2026-06-14", "MLB SS Hoodies Restock + New", "Soft Launch", None, None, None, "10:00:00", "PST"),
    ("2026-06-16", "Baseball Nation Five Panel and Dad Cap + Shorts", "Soft Launch", None, None, "Remarket Americana, may launch shorts if any are late", "10:00:00", "PST"),
    ("2026-06-18", "Pitchers That Paint", "Main Event", "Mark", "2026-03-05", None, "10:00:00", "PST"),
    ("2026-06-19", "Gift Card Push - Father's Day", None, None, None, None, None, None),
    ("2026-06-20", "Prime Day - Mystery Boxes", None, None, None, None, None, None),
    ("2026-06-21", "Father's Day Holiday", "Filler Promo", None, None, None, "10:00:00", "PST"),
    ("2026-06-25", "Bubbles and Doubles - Shorts, Tees, Caps", "Filler Promo", None, None, "also start marketing back to school in the evening", "10:00:00", "PST"),
    ("2026-06-28", "Ballplayer Box #2 Threshold", "Filler Promo", None, None, None, "10:00:00", "PST"),
    ("2026-07-01", "Pin of Month", "Soft Launch", None, None, None, "00:00:00", "EST"),
    ("2026-07-02", "Youth Caps", "Filler Promo", None, None, "Push for kids age 11 & under - size 7 head and smaller", "10:00:00", "PST"),
    ("2026-07-05", "Dodgeball Legend", "Main Event", "Russ", "2026-03-07", "Youth Tee", "10:00:00", "PST"),
    ("2026-07-09", "Banana Split", "Main Event", "Russ", "2026-03-11", "Youth Tee, Youth Shorts", "10:00:00", "PST"),
    ("2026-07-12", "Performance Collection Refresh", "Soft Launch", None, "2026-02-12", "2 colors of new performance tee (youth), 1 adult (black)", "10:00:00", "PST"),
    ("2026-07-14", "MLB Keychains, bracelets, pins", "Soft Launch", None, None, None, None, None),
    ("2026-07-16", "Back To School", "Main Event", None, "2026-02-26", None, None, None),
    ("2026-07-19", "National Ice Cream Day", "Filler Promo", None, None, None, None, None),
    ("2026-07-26", "Quote Tees/Branded", None, "Mark", None, None, None, None),
    ("2026-07-31", "Back to school sale end", "Promotion End", None, None, None, None, None),
]


def esc(s):
    if s is None:
        return None
    return s.replace("'", "''")


def sql_val(v):
    if v is None:
        return "null"
    return "'" + esc(v) + "'"


def build_notes(zone, design_due):
    parts = ["seed:jun-jul-2026"]
    if zone:
        parts.append(f"TZ: {zone}")
    if design_due:
        parts.append(f"Design due: {design_due}")
    return " · ".join(parts)


lines = [
    "-- =============================================================================",
    "-- Seed: Full marketing calendar Jun–Jul 2026 (from planning spreadsheet)",
    "-- Run in Supabase SQL Editor. Cleanup: see supabase/seeds/README.md",
    "-- =============================================================================",
    "",
    "do $seed$",
    "declare",
    "  uid uuid;",
    "  lid uuid;",
    "begin",
    "  select id into uid from auth.users order by created_at limit 1;",
    "  if uid is null then",
    "    raise exception 'No auth.users found. Sign in once or set uid in this script.';",
    "  end if;",
    "",
]

for date, title, launch_type, designer, design_due, details, time, zone in ROWS:
    lt = launch_type or "Other"
    campaign = launch_type or "Other"
    notes = build_notes(zone, design_due)
    priority = "high" if launch_type == "Main Event" else "normal"
    lines.append("  insert into public.launch_calendar (")
    lines.append("    title, launch_date, launch_time, launch_type, campaign_type, status,")
    lines.append("    priority, launch_readiness, designer, details, notes, created_by")
    lines.append("  ) values (")
    lines.append(f"    {sql_val(title)}, {sql_val(date)}, {sql_val(time)}, {sql_val(lt)}, {sql_val(campaign)},")
    lines.append(f"    'planned', {sql_val(priority)}, 'not_reviewed', {sql_val(designer)}, {sql_val(details)},")
    lines.append(f"    {sql_val(notes)}, uid")
    if title == "6432 Day":
        lines.append("  ) returning id into lid;")
        lines.append("")
        lines.append("  insert into public.launch_channel_items (")
        lines.append("    launch_id, channel, item_title, scheduled_date, scheduled_time, status, notes, created_by")
        lines.append("  ) values")
        lines.append("    (lid, 'email', '6432 Day — email 1', '2026-06-04', '08:00:00', 'planned', 'seed:jun-jul-2026', uid),")
        lines.append("    (lid, 'email', '6432 Day — email 2', '2026-06-04', '09:30:00', 'planned', 'seed:jun-jul-2026', uid),")
        lines.append("    (lid, 'sms',   '6432 Day — SMS 1',   '2026-06-04', '10:00:00', 'planned', 'seed:jun-jul-2026', uid),")
        lines.append("    (lid, 'sms',   '6432 Day — SMS 2',   '2026-06-04', '14:00:00', 'planned', 'seed:jun-jul-2026', uid);")
    else:
        lines.append("  );")

lines.extend([
    "",
    "  raise notice 'Seeded % launch rows for Jun–Jul 2026 (user %).', 27, uid;",
    "end",
    "$seed$;",
    "",
    "select launch_date, launch_time, launch_type, designer, title",
    "from public.launch_calendar",
    "where notes like 'seed:jun-jul-2026%'",
    "order by launch_date, title;",
])

out = Path("supabase/seeds/launch_calendar_jun_jul_2026.sql")
out.write_text("\n".join(lines) + "\n")
print(f"Wrote {len(ROWS)} launches to {out}")
