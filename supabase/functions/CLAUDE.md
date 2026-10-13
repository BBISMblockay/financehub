# supabase/functions/ — edge function rules

Per-function behaviour, secrets and history: [`docs/agents/edge-functions.md`](../../docs/agents/edge-functions.md).

## Deploying
- **Merging does not deploy, and agents do not deploy without Blake's explicit approval in the
  session.** The approved route is the "Deploy Edge Function" workflow from `main`. Never paste
  source through an API client (it truncated two `silo-chat` deploys).
- A NEW function whose caller has no Supabase JWT (webhook, OIDC, public form) must be added to
  `NO_JWT_FUNCTIONS` in `deploy-edge-function.yml`, or it rejects its callers before the handler runs.
  The drift check prints each function's `verify_jwt`; confirm it after deploying a public one.
- The drift check compares every deployed function with `main`. A red run right after a merge means a
  deploy is owed: report it and ask, never deploy on the check's word.
- **A shared import is bundled into each function that imports it.** `card-coding-prepare-scheduled`
  imports `../card-categorize/prepare.ts`: changing that file means BOTH need redeploying
  (with approval, as above).
- Not everything deployed has source here (`notify-slack`, `bright-action`, `replace-product-tags`,
  `oneoff-meta-sync`), and some DB triggers call functions by URL. Check `pg_trigger` before adding a
  trigger or notification, or you may double-send.

## Code
- **Verbatim copies are pinned by tests.** Some functions ship copies of `scripts/lib/` modules or of
  each other's libs (`ad-platform-sync-run/lib/`, `silo-chat/report-params-lib.mjs` ↔
  `v3/js/report-params.js`, `ai-credit-lib.mjs`, `google-oauth-lib.mjs`). Edit the original, re-copy,
  and let the test confirm. Never edit only the copy.
- Testable functions put the handler in `handler.ts`/`.mjs` (or a `*-lib.mjs`) with a thin `index.ts`,
  so node tests can execute it. `deno check` proves types, not behaviour.
- Use the caller's JWT and RLS for authorization; reach for the service role only for the write after
  that check, and say why.
- Never take a company id from the request body; read the caller's `active_company_id`.
- **Two-step login (20261014000000).** The Data API refuses an enrolled user's password-only session
  with a pre-request hook, but a function that checks the caller with `auth.getUser()` and then
  reads or writes ONLY with the service role never sends the caller's token to PostgREST. Such a
  function must call `checkMfaSession` (`mfa-gate.mjs`, a verbatim copy of
  `scripts/lib/mfa-gate.mjs`) right after `getUser` and before its first service-role call, and be
  added to the list in `scripts/tests/mfa-gate.test.mjs`. A function whose first step is a
  caller-token PostgREST call whose error aborts is already covered. The gate fails closed: apply
  the migration before deploying a gated function.
- Email sender comes from `SILO_MAIL_FROM` (fallback `SILO <noreply@silo-baseballism.com>`).
- **Ask SILO (`silo-chat`):** prompt text lives in `prompt-lib.mjs`. `CORE_PROMPT` is cached and must
  stay byte-identical per request; never put per-request content in it. Brand and voice are company
  DATA (`silo_chat_notes`), never hardcoded. Schema facts belong in `silo_chat_schema_catalog`, not in
  the prompt.
- **Stripe:** every handler re-fetches the object from Stripe and syncs what came back. Never write a
  mirror row from what the code believes happened. An ambiguous failure (timeout, 5xx) keeps its
  idempotency key so the retry collapses onto the original, and the browser keeps that key in
  `sessionStorage` because the real retry is a reload. `onboarding_completed_at` does not mean
  onboarded; read `charges_enabled` / `details_submitted`.
