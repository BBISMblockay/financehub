# Public early-access queue

## Scope

The public `get-silo.com` landing page collects Name, Company Name and Email for
personal early-access follow-up. It does not create an account, tenant, invitation,
subscription or payment, and does not send email. Existing sign-in, invite and
password-recovery routing remains in place.

The landing keeps SILO's existing logo, Plus Jakarta Sans and hero assets. The
product video is not yet supplied. `pages/config.js` intentionally leaves
`LANDING_DEMO_VIDEO_URL` empty, so the page displays an honest preview placeholder
without a play button. Once approved, set that property to the final supported
media URL; native video controls are used, without autoplay or an iframe.

## Boundaries

- The browser submits only to the `onboarding-interest` Edge Function.
- The dedicated `onboarding_interest_queue` is separate from employee
  `access_requests` and platform invitations.
- Visitors cannot read or write the table directly.
- `is_platform_admin()` protects queue reads and status changes at the database
  layer. Company owners/admins do not gain prospect access through their role.
- Silo Admin (`/v2/platform-admin.html`) lists 25 entries at a time and can change
  only `pending`, `contacted` or `closed` status. Saving a status has no other
  side effect. A stale status update requires a reload rather than overwriting
  someone else's change.
- Normalized email deduplication preserves the original name/company and gives
  the same acknowledgement as a new persisted request. It never checks whether
  an email belongs to an existing SILO account.
- Failed or uncertain form submissions retain inputs and permit a retry. The
  client requires both a successful HTTP status and `ok: true` before displaying
  an acknowledgement.

## Release order

1. Review the additive migration, isolated database privilege tests, endpoint
   tests and browser fixtures with the PR.
2. Apply only the reviewed new queue migration to the Silo project. Do not run
   the repository-wide apply-all script as part of this change.
3. Verify the new tables, RLS policies, column/function privileges and existing
   schema checks using read-only queries. Do not create fake production leads.
4. After deployment is separately approved, deploy the `onboarding-interest`
   function with JWT verification disabled for this intentionally public intake.
   The existing manual Deploy Edge Function workflow records the exact commit.
   Existing Supabase service credentials are used only within the function; no
   new credential grant is required.
5. Merge/publish the frontend only after the endpoint is deployed. A frontend
   published first shows a retryable save error; it does not claim a queued lead.
6. Supply and approve the final product video separately. It is not a prerequisite
   for the interest form, but the placeholder must remain honest until then.

Creating this PR does not merge or deploy it. Applying the additive database
migration alone does not activate the public endpoint or change the live page.
