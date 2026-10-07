# Agent reference

The root `CLAUDE.md` holds the rules every session needs. These files hold the detail it used to
carry inline: table-by-table notes, function behaviour, measurements and the history behind each rule.
Read the one that matches the area you are changing before you change it.

| File | Read it when you touch |
|------|------------------------|
| [architecture.md](architecture.md) | Page structure, file layout, `pages/config.js`, the three page patterns, Beacon classes and tokens |
| [database.md](database.md) | Any table, view, RPC, policy, storage bucket or migration. The **Key tables** section has one row per table with its invariants |
| [edge-functions.md](edge-functions.md) | Anything under `supabase/functions/`, email sending, Stripe, Shopify/Google/TikTok OAuth, Ask SILO's edge function |
| [github-actions.md](github-actions.md) | Any workflow, sync schedule, backfill or the drift / freshness / tie-out checks |
| [working-method.md](working-method.md) | The full preflight / review method, `/steward`, conventions for new pages and tables |
| [current-status.md](current-status.md) | What each shipped module does, what is deliberately hidden from the nav, and known repo leftovers |

Per-directory rules also load automatically from `supabase/CLAUDE.md`, `supabase/functions/CLAUDE.md`,
`v3/CLAUDE.md` and `scripts/CLAUDE.md`.

**Keeping this useful:** a new rule gets one line in the right `CLAUDE.md`, and its reasoning and
measurements go here or in `docs/ops/`. A rule that a check already enforces (`verify_v2_schema.sql`,
the drift check, the tie-out run, a test) only needs a line saying so.
