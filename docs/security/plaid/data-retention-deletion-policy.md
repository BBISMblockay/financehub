# Data retention and deletion policy — draft

Version 0.1; owners: Privacy, Finance and Engineering (unassigned).
Approver/effective date: **pending / not adopted**. Review annually and after new
data collection, vendor changes or changes to accounting obligations.

This draft defines a procedure and a schedule to approve. No retention duration
below is a claim of an existing job or a legally required term. Resolve all TBD
durations and implement/test disposition before attesting P05.

## Schedule to approve

| Data class / copies | Purpose and retention trigger | Duration decision | Disposition / owner |
|---|---|---|---|
| Plaid API secrets and encryption keys | Necessary integration/key custody | Active use plus explicitly bounded rotation/recovery overlap; final overlap TBD | Revoke/retire after dependency verification; Engineering |
| Item access-token ciphertext | Retrieve authorized account data | Until permanent revocation/disconnection; cleanup target TBD | Revoke Item, remove recoverable credential copies; Engineering |
| Link/public tokens and signed state | Short-lived Link operation | Provider expiry / signed expiry; inspect any browser storage and logs | Expire and clear transient state; Engineering |
| Account metadata, balances, raw transactions, sync exceptions | Reconciliation and accounting support | Approved accounting period from record creation/fiscal close, TBD by Finance/Privacy | Minimize/delete/anonymize when no longer needed and not held |
| Ledger batches, approvals, postings and finance audit snapshots | Accounting integrity and audit | Approved fiscal-close-based term TBD; document justification | Controlled archival/disposition preserving required integrity; Finance |
| Profiles, membership/invitation records, identity/security logs | Access control and accountability | Active use plus approved post-revocation/audit term TBD | Minimize personal fields while preserving required attribution; IT/Privacy |
| Reports, exports, attachments, AI requests/responses and processor copies | Downstream operational use | Per-purpose and processor terms, TBD | Track recipient systems and request/verify cleanup; Privacy/system owner |
| Backups, restore points and private evidence | Recovery and audit | Document actual configured expiry and approved maximum, TBD | Expire on schedule; apply deletion ledger before restored data is used |

Document data location, controller/processor role, classification, subject/company
keys, active replicas and legal-hold handling for every class. Plaid history-request
days control retrieval, not deletion or retention. Account pausing is not revocation.

## Verified deletion workflow to implement

1. Receive a request through the approved contact, verify requester authority and
   identify the user/company/Items and scope without collecting unnecessary data.
2. Record request ID, received date, applicable response deadline, system owner
   and any legal/accounting hold. Privacy/Finance determines the deadline from
   applicable obligations and the approved policy; do not invent one here.
3. Stop new ingestion and coordinate in-flight leases/jobs so no data is re-created.
   Distinguish requested **pause**, **revoke connection**, and **erase eligible data**.
4. For permanent revocation, call the appropriate Plaid Item-removal operation
   using server-held credentials and capture a non-secret confirmation. Preserve
   retry state if the outcome is ambiguous; do not report success prematurely.
5. Remove eligible token ciphertext, metadata, raw payloads, exceptions, derived
   reports, exports and other copies. Identify protected financial records and
   audit payloads before deletion. Confirm downstream processors' required actions.
6. Append-only audit controls reject deletion today. Design and review any archival,
   redaction or disposition migration with Finance/security approval and verified
   recovery; do not disable immutability as routine cleanup. Record any lawful
   retained subset, reason and expiry separately from deleted data.
7. Backups may expire on a bounded schedule rather than support selective deletion.
   Record that limit, protect restore points and retain a restricted deletion ledger
   so restored data is suppressed/deleted before access or syncing resumes.
8. Verify absence or approved minimization in every active store, no usable revoked
   tokens, no scheduled re-ingestion and the backup/downstream disposition plan.
   Independently review and send an accurate completion/partial-completion response.

Track each step's pending/succeeded/failed state with retries, escalation and an
owner. Failed or partially completed deletion is not completion. Use synthetic
staging data for normal, held, partial-failure, concurrent-sync and restore tests.
Keep completed [request records](evidence-templates.md#retention-or-deletion-record)
privately. No deletion action is authorized or executed by this document.

## Current implementation constraint

See [E04](repository-evidence.md#e04-pausing-is-not-deletion): SILO's current
`disconnect` action only pauses syncing, retains tokens and records, and does not
provide this end-to-end workflow. The privacy notice must reflect actual behavior
until revocation/deletion is implemented and verified.
