# Known bugs & limitations

Only items that still matter today. Fixed items live in [CHANGELOG.md](CHANGELOG.md).

**Severity:** P1 = workflow blocked · P2 = workaround exists · P3 = polish

---

## Fix these first (P1)

| Issue | Workaround |
|-------|------------|
| PO tables missing → costing/profile errors | Run [`supabase/apply_all_post_merge.sql`](../../supabase/apply_all_post_merge.sql) |
| RLS wrong → users see too much/little data | Fix policies in Supabase dashboard |

---

## Common (P2)

| Issue | Workaround |
|-------|------------|
| Costing fallback JSON in `po_headers.internal_notes` | Apply migrations; move data into `po_costing` |
| `po_*_can_write()` roles don’t match your `profiles.role` values | Edit role list in SQL migration |
| Old bookmarks hit `/finance.html` instead of `/v2/finance.html` | Use `/v2/*` paths; update links in `silo-chrome.js` |
| Many v2 pages still iframe legacy HTML | Expected until Beacon migration (see roadmap) |
| Planning: projection seed has no product type | By design — see [planning-scenarios-filter-scope.md](../planning-scenarios-filter-scope.md) |
| Optional DB view missing → empty open POs on planning page | Create view in Supabase or ignore |

---

## Low priority (P3)

| Issue | Notes |
|-------|-------|
| Error UX differs (`alert` vs status line vs debug box) | See [errors.md](errors.md) |
| Planning v2 UX was clunky | Rebuilt from v1; old analysis in [planning-scenarios-v2-ux-plan.md](../planning-scenarios-v2-ux-plan.md) |

---

## Report a new bug

Add a row here (or a GitHub issue) with: symptom, page/URL, severity, workaround if any.
