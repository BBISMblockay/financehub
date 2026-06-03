# Fixes log

Short list of **resolved** issues. Active problems stay in [bugs.md](bugs.md).

| When | Area | What was fixed |
|------|------|----------------|
| 2026-06 | Supabase schema | Verified all tables, RLS, and policies healthy across PO builder, costing, profiles, and launch workbench |
| 2026-06 | Supabase schema | Created missing `po_builder_can_write()` function (was in migration but hadn't applied) |
| 2026-06 | RLS | Confirmed all 13 tables have RLS enabled; PO builder had pre-existing dashboard policies — all access working |
| 2026-06 | Roles | All 7 profiles are `admin` — full write access to PO builder and costing confirmed |
| 2026-06 | Launch comments | `author_name`, `author_email`, `user_id` columns confirmed present on `launch_comments` |
| 2026-05 | Planning Scenarios v2 | Restored v1 revenue/mix/ASP logic; filter scope parity — see [planning-scenarios-filter-scope.md](../planning-scenarios-filter-scope.md) |
| 2026-05 | Planning Scenarios v2 | Rebuilt page from v1 layout + projection seed + Beacon theme |
| 2026-05 | PO module | SQL migrations for builder, costing, profile RLS — [supabase/README.md](../../supabase/README.md) |
