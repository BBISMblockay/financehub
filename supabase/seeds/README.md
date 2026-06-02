# Launch Workbench — seeding known events

Use this when you want the **marketing calendar spreadsheet** in Supabase so `/v2/launch-calendar.html` shows real dates without hand-entering each row.

## Option A — SQL (recommended)

1. Open **Supabase → SQL Editor**.
2. Open `launch_calendar_jun_jul_2026.sql` in this folder.
3. At the top, set `seed_user` to your user id (or leave the subquery that picks the first `auth.users` row).
4. **Run** the script.
5. Hard refresh Launch Workbench (look for **WB-96** or newer build tag).

Rows are tagged with `notes = 'seed:jun-jul-2026'` so you can remove them later:

```sql
delete from launch_channel_items
where launch_id in (select id from launch_calendar where notes = 'seed:jun-jul-2026');

delete from launch_calendar where notes = 'seed:jun-jul-2026';
```

## Option B — Enter in the UI

For a handful of launches: **+ NEW LAUNCH** → fill title, date, type, designer, details → save. Add products/initiatives in the drawer.

## Spreadsheet → database mapping

| Spreadsheet column | `launch_calendar` column |
|--------------------|---------------------------|
| Event | `title` |
| Date | `launch_date` (YYYY-MM-DD) |
| Time | `launch_time` (24h, e.g. `10:00:00`) |
| Zone | append to `notes` (e.g. `TZ: PST`) |
| Launch Type | `launch_type` (and often `campaign_type`) |
| Designer | `designer` |
| Details | `details` |
| Design Date | prefix in `notes` (`Design due: …`) |

**Initiatives** (email/SMS on other dates) belong in `launch_channel_items`, not extra launch rows. The sample seed adds one initiative for **6432 Day** as an example.

## Adding more rows from Excel

1. Export sheet as **CSV**.
2. Duplicate the `INSERT` pattern in the SQL file, or ask for a one-off import script with your CSV path.
3. Keep `launch_date` + `title` unique enough to avoid duplicates.

## Status defaults in the seed

| Launch date vs today | `status` |
|----------------------|----------|
| Before today | `launched` |
| Today and future | `planned` |

Adjust after seeding in the UI if needed.
