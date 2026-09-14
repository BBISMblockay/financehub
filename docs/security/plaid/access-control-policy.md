# Access control, identity and lifecycle policy — draft

Version 0.1; owner: unassigned Security/IT owner; approver: unassigned executive.
Effective date: **not adopted**. Review annually and after material identity changes.
The following is the proposed operating policy for P01/P02/P03/P07/P08/P10/P11.

## Scope and grants

Maintain an inventory of SILO identities, company memberships, roles and finance
permissions; GitHub access; Supabase organization/project/database access; Plaid
Dashboard access; hosting/DNS; secret stores; CI workloads; endpoint administrators;
and vendors/support tools that can access financial data.

Every human uses an individual account. Require manager approval plus system/data
owner approval for privileged or finance access, a recorded business purpose and
the minimum role/company scope. Prohibit routine shared human credentials. Use
time-limited elevated access where supported, log its use, and separately control
emergency accounts with monitored use and post-use review.

Application identities and workforce/cloud administrators are distinct populations.
Supabase Auth for the app alone does not establish workforce-wide centralized IAM.

## MFA and identity

Use an authoritative identity directory and map every in-scope system to it through
SSO/provisioning where supported. Reconcile unavoidable local accounts with the
directory; record and review exceptions and service accounts. Centralized inventory
without centralized lifecycle enforcement is not sufficient for P10.

Require MFA for humans accessing internal systems that store/process Plaid data,
including cloud/source/secret administration. Prefer phishing-resistant authenticators
for administrators; inventory factor methods, enforcement scope and recovery paths.
Protect recovery, factor resets and emergency access against bypass.

For SILO users who can invoke Plaid Link or access its data, implement enrollment,
challenge, recovery and backend enforcement. Check the authenticated assurance level
on sensitive Edge requests AND protect direct database/RPC reads and writes with
the applicable assurance policy. A browser redirect or enrolled factor alone is
insufficient. Workload identities use explicit machine authentication rather than
an MFA exemption shared with human accounts.

Test password-only sessions, missing/invalid assurance, direct APIs, expired sessions,
factor reset/recovery, company switching and workload scope. Bank login/MFA inside
Link is separate from SILO MFA. Confirm P11 applicability with Plaid if the app
only connects company-owned accounts; keep it unresolved until accepted.

## Joiners, movers and leavers

Proposed timing, subject to adoption:

| Event | Trigger and action | Target |
|---|---|---|
| Joiner | Approved manager request creates minimum identity/role/company grants; enroll MFA before sensitive access | Before first access |
| Transfer | Authoritative HR/IdP event removes old grants before applying approved new ones; reconcile all company memberships | By effective transfer time |
| Termination | Authoritative event disables access, revokes sessions and tokens, removes grants, revokes outstanding invites and checks owned integrations | By effective termination time; immediately for urgent involuntary removal |
| Automation failure | Alert IT/security; perform recorded manual containment and reconcile every connector | Immediately on detection |

Implement automation from the authoritative event through every target system.
Use idempotent, retryable steps with durable status per target, timestamps and
failure alerts. Test both termination and transfer, plus a failed connector and
recovery. A checklist or manual `is_active` edit is not automated de-provisioning.

Revoke refresh sessions and verify still-valid access tokens cannot perform
sensitive operations. User deletion alone is not evidence of immediate session
revocation. Preserve accounting attribution as required; do not blindly cascade
delete finance records. Transfer workload ownership and rotate shared credentials
if the departing user could retrieve them.

## Access reviews

Proposed cadence: quarterly for all in-scope access, monthly for privileged and
finance access, and immediately after a material event. These cadences require
owner approval and calendar assignment; no historical reviews are claimed.

1. Export dated populations from the identity source and each target system.
2. Match human identities to active employment/contract and business purpose;
   match workload identities to an owner and necessary scope.
3. Review stale/inactive accounts, all company memberships, elevated roles,
   local exceptions, unused tokens, outstanding invites and MFA coverage.
4. Record keep/change/remove decisions and approver. Revoke unnecessary grants
   promptly and verify denial after removal, including existing sessions.
5. Independently verify closure; retain the private evidence and next review date.

Use the [access-review template](evidence-templates.md#access-review-record).
Application audit logs and functional tests do not demonstrate periodic reviews.
