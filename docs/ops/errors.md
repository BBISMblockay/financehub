# Error handling cheat sheet

Where errors show up, by layer. Use this when adding a new page or debugging “nothing happened.”

---

## Browser pages

| What happened | What the user usually sees |
|---------------|------------------------------|
| Bad/missing `pages/config.js` | Whole page replaced with “Missing Supabase config” |
| Not signed in | Redirect to `/pages/login.html` |
| Load failed | Red text in `#statusLine` or “Load failed” in status area |
| Save validation | `alert()` on some pages (e.g. launch calendar) |
| Admin denied | `alert("Access denied…")` on backend-style pages |
| Developer detail | `console.warn` / `console.error` only (DevTools) |

**Convention for new v2 pages:** config gate → auth redirect → visible status message → `console.error` for support. Avoid `alert` for routine errors.

---

## Node sync (`scripts/`, `server/`)

| What happened | What you see |
|---------------|--------------|
| Missing env vars | Process exits immediately with clear message |
| Shopify rate limit | Retries (429) in `server/index.mjs` |
| Supabase write fail | Thrown error; GitHub Action step goes red |

---

## Supabase / RLS

API returns `{ error }` with a message (often “permission denied”). Fix **policies or role**, not the anon key in frontend.

**Never** ship `SUPABASE_SERVICE_ROLE_KEY` in HTML or git.
