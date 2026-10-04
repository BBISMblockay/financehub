# Public early-access queue

## Scope

The standalone `/demo.html` page collects Name, Company Name and Email for
personal early-access follow-up. It does not create an account, tenant, invitation,
subscription or payment, and does not send email. Existing sign-in, invite and
password-recovery routing remains in place. The existing homepage is unchanged, and no
new homepage or navigation link is added.

For now the page is the Redo Marketing landing: poster layout, Ask Silo analysis
as its own section, and framed spots (`Interface image`, `Ask Silo screen`) where
a real product screen can replace the sample chart and sample analysis. The
hero artwork file stays in the performance frame only as the unloaded-video
fallback; it is not the picture visitors see. `LANDING_DEMO_VIDEO_URL` is
intentionally unconfigured, so that frame stays a sample chart without a play
button. Once approved, configure that optional property with the final supported
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

## Durable intake bounds

The service-only RPC takes name, company name, normalized email and a per-address
key. It admits at most 30 requests per minute and 300 per day across everyone,
and at most 3 per hour per address, using two reusable global counters plus one
counter per address. The per-address key is an HMAC computed only in the Edge
Function under the service key, so the database holds no address, hash of a
known shape, IP or client metadata. Every bound is checked before any counter is
touched, so a refused request adds no row; an admitted request adds at most one.
Nothing is ever removed from the counter table: an expired counter resets in
place on its next hit, and the table grows by at most the daily cap. Duplicate
requests consume quota like new ones and never overwrite the original lead.
A sender rotating addresses can still exhaust the shared daily quota; that is the
availability tradeoff for a small public intake without a trusted client-IP
contract. A sender repeating one address cannot.

Before first application, migration `20261003221720_onboarding_interest_queue.sql`
was revised on 2026-10-04 after read-only verification that its objects and
migration history entry were absent. It contains no DROP, DELETE or TRUNCATE operations,
creates policies only if absent, and grants no removal privilege on either table.

## Release order

1. Review the additive migration, isolated database privilege tests, endpoint
   tests and browser fixtures with the PR.
2. Apply only the reviewed new queue migration to the Silo project. Do not run
   the repository-wide apply-all script as part of this change.
3. Run `supabase/verify_v2_schema.sql` as after any DB change. Its two
   "Early-access intake" checks verify the new tables, RLS policies and
   column/function privileges read-only and must report `ok`; the daily
   deployment drift check runs the same file, so a later widening of these
   grants goes red on its own. Do not create fake production leads.
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
