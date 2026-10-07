# Working method, PR workflow and conventions (full text)

> Moved verbatim from the root `CLAUDE.md` on 2026-10-07 (agent-guide restructure). The root file keeps the rules; this file keeps the detail and history. Update here, not in the root.

## Working method — preflight before code, adversarial review after

**This is a required sequence, not advice.** It exists because of a repeated,
expensive pattern: entering build mode before finishing attack-the-design mode,
so verification keeps exposing assumptions *after* the work has already been
described as finished. Each round of "wait, I found another thing" costs a
review cycle, and most of those findings were available before a line was
written.

### 1. Preflight (read-only, before writing any code)

Do not edit anything until you have walked, and can name:

- **Every call site** of every function you intend to change — including
  callbacks, and including the ones only reachable from a workflow or an edge
  function rather than from a test
- **Every workflow input** that reaches the code, and what happens when two of
  them contradict each other
- **Every database policy and grant** the change touches. Read them from
  `pg_policy` / `pg_constraint` / `has_function_privilege`, never from a
  migration file — the live definition is the one that matters, and Supabase's
  default privileges silently re-grant EXECUTE on new `public` functions
- **Every partial-failure path**: what is already written when step N fails,
  and what the record says about it afterwards
- **Retry and resume behaviour**: what a re-run repeats, and what it continues
- **Every destructive operation**, and what makes it safe *by construction*
  rather than by the caller remembering to be careful
- **Concurrency**: two runs, a queued run, a cancelled run
- **Every success / skip / error state**, and whether each one is
  distinguishable from the others by someone reading only the stored record

Then write down, explicitly: **the assumptions that require live verification**,
and **the tests, defined before the implementation**.

### 2. Implement.

### 3. Adversarial review of the FINAL INTEGRATED CALL PATH

A separate pass, after the code is written — not a re-read of the helpers you
just tested. Helper functions passing in isolation is exactly the state in which
a temporal-dead-zone reference shipped in an orchestrator callback that no test
ever executed (2026-09-09): the core function had 91 passing assertions and the
five lines that actually called it had none. Run the real path, with the real
wiring, in the shape production uses.

Mutation-test the suite while you are there: break each fix deliberately and
confirm a test fails. A test that passes against the bug it claims to prevent is
worse than no test, because it is credited as coverage.

### 4. Language

**Do not say "ready", "done", or "complete" until review and verification have
both actually happened.** While anything is unverified, the phrase is
**"implementation complete, verification pending"**, followed by the specific
unknowns. Some findings genuinely require a live environment and will still
arrive late — that is fine and expected. Announcing completion before the phase
that would have caught them is not.

---

## PR workflow — `/steward`

`.claude/skills/steward/SKILL.md` is the PR ownership protocol: open the PR review-ready (checks
by touched path, a body with verification / risks / migration-deploy sections), wait for the
ChatGPT independent review (it posts one review on the PR and one on the next push, then stops —
a two-cycle budget, not an approval; its `silo-pr-review-v1` marker comments carry cycle, head sha
and status, and only `status=complete` is a review), evaluate every finding against the code, push
ONE correction batch per cycle, and end with a readiness assessment that names the head sha, the
last reviewed sha (both read from the markers), and one of three statuses. The harness reads that file automatically before acting on any
review or CI event on a PR Claude opened; `/steward <task>` starts it by hand. It never merges,
deploys, applies a migration, or touches production data — those stay Blake's.

---

## Conventions for new features

### Adding a new v2 page
1. Use Pattern 1 (Full Beacon shell) — copy `v2/projections.html` or `v2/tasks.html` as a starting point
2. Follow the exact asset load order from SILO-BRAND.md (`nav-config.js` before `silo-chrome.js`)
3. Mount SiloChrome after auth succeeds
4. Add the page to `NAV_ITEMS` in **`v2/nav-config.js`** (not `silo-chrome.js` — that only renders what
   `SiloNav` defines). Set `profiles` (`grandfathered` / `standard`), plus `departments` / `roles` /
   `grantTable` if the link should be gated. Nav gating is UX only — the real boundary is RLS.
   `requiresGrant: true` (with `grantTable`) makes the grant the ONLY way in — unlike `roles`, which
   fails OPEN while the profile fetch is in flight; use it for anything outside the workspace's own
   scope, as the `platform/admin` row does
5. Create a stub redirect at `v2/[oldname].html` if you are replacing an existing page's URL

### Adding a new DB table
1. Write a migration file: `supabase/migrations/YYYYMMDDHHMMSS_description.sql`
2. Make it idempotent (`if not exists`, `create or replace`)
3. Enable RLS: `alter table public.tablename enable row level security`
4. Add policies (select for all authenticated, write gated by role if needed)
5. **If the table carries `company_entity_id`, end the migration with
   `select public.attach_stamp_company_entity_id_triggers();`** — the BEFORE
   INSERT stamp is the backstop for an insert that forgets to set the company,
   and it is not automatic. `20260919140000` added six `customer_account*`
   tables without it and `verify_v2_schema.sql` check 6 was MISSING on every
   drift run from that merge until 2026-09-20. Since `20260920150000` the
   function touches ONLY tables whose trigger is missing or wrongly bound, so a
   call with nothing to do takes no locks — that is what makes it safe as a
   routine step rather than 164 `ACCESS EXCLUSIVE` locks per migration. It
   skips `inventory_on_hand` / `sales_by_day`
6. Add the table to `supabase/verify_v2_schema.sql`
7. Add the table to `supabase/apply_all_post_merge.sql`
8. Update `supabase/README.md` migration list
9. **If you applied it straight to prod (Supabase MCP/CLI), open the PR in the
   same session.** Prod must never sit ahead of `main` with the repo record
   parked on an unmerged branch — that is the same drift as an undeployed edge
   function, just pointing the other way, and it is worse: rebuilding from
   `apply_all_post_merge.sql` on `main` would produce a database missing an
   object that exists in production. Applying directly is fine (a view or an
   additive column is reversible); leaving it unPRed is not.

### JS logic
- Shared logic used by more than one page → extract to a `.js` file in `v2/` or `pages/`
- Page-specific logic → inline `<script>` at bottom of the HTML file is acceptable
- Do NOT add logic to `silo-chrome.js`, `tool-shell.js`, or `v2-shell.js` — those are framework files.
  `nav-config.js` is the exception: it's data, and adding/gating a nav link belongs there

### Error handling
Use the `bcn-status` pattern — not `alert()`. Every page should have a status element:
```html
<div class="bcn-status" id="status" hidden></div>
```
```js
function setStatus(msg, type = 'info', ms = 0) {
  const el = document.getElementById('status');
  el.className = `bcn-status bcn-status--${type}`;
  el.textContent = msg;
  el.hidden = false;
  if (ms) setTimeout(() => { el.hidden = true; }, ms);
}
```

---

## What NOT to do

- **Do not edit `legacy/` files** — they are archived, not in use
- **Do not hardcode Supabase credentials** in HTML — use `window.__SILO_CONFIG__`
- **Do not reference `profiles.app_role`** — the column does not exist; use `profiles.role::text`
- **Do not add logic to stub pages** (the 24-line redirect files) — rebuild as Pattern 1 instead
- **Do not use `alert()`** for errors — use the `bcn-status` pattern
- **Do not create new CSS variables** — use existing Beacon tokens from `beacon.css`
- **Do not push to main directly** — always use a feature branch
- **Do not treat `/v3/` as the new `/v2/`** — it is one feature (the dashboard runtime), not a
  successor directory. New tools still go in `v2/` as Pattern 1 pages
- **Do not build new tools at the repo root** — root `.html` files are legacy iframe targets and
  superseded originals. New pages go in `v2/`
- **Do not copy a root-level page as a starting point** — several have no auth wiring at all. Copy a
  current Pattern 1 page from `v2/` instead
- **Do not assume a nav link means a page is gated** — `nav-config.js` only controls sidebar
  visibility. Authorization is RLS

---
