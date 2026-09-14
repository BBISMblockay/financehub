# Privacy notice review and proposed Plaid wording

**Draft for Privacy/Finance/product review; not approved for publication.**
The public [privacy notice](../../../legal/privacy.html) is already reachable over
HTTPS, but its scope and disclosures need reconciliation before P04 sign-off.
This file does not change that public notice or declare new collection practices.

## Required decisions before publication

1. Confirm legal operator, users and account ownership. The existing notice says
   internal-only/no public signup; the login implements new-organization signup.
   Verify deployed signup settings and actual usage, then align product and notice.
2. Confirm enabled Plaid products, purposes, fields, institutions, regions and
   whether any personal accounts or external users are permitted. The reviewed
   bank-feed source uses Transactions and account/balance metadata; do not imply
   that unimplemented products are collected.
3. Approve descriptions of optional AI categorization and other report/AI/export
   paths. The categorizer can transmit transaction descriptors, card/merchant
   names, totals and accounting context to Anthropic; confirm actual enabled use,
   processor contracts, permitted data uses, retention and deletion terms.
4. Replace vague retention language with the approved, implemented schedule or
   accurate retention criteria. Confirm handling of accounting/audit holds,
   backups, downstream copies, and the real contact for requests.
5. Correct any blanket claim that disconnecting integrations deletes tokens.
   Plaid's current Stop syncing action only pauses SILO ingestion. Review other
   providers individually; do not extend the QuickBooks deletion statement to Plaid.
6. Confirm the privacy contact works, review applicable rights/notice obligations,
   approve the effective date and make the notice accessible before Link begins.

## Proposed section: Connected bank and card accounts

The following is candidate wording to reconcile with confirmed scope and controls:

> When an authorized user connects a permitted bank or card account, SILO uses
> Plaid to retrieve account information, balances and transaction data for internal
> accounting, reconciliation and reporting. This may include institution and
> account names, account type and masked identifiers, transaction dates, amounts,
> descriptions, merchants and transaction categories. Plaid provides the connection
> experience; SILO does not ask users to send us their online banking passwords.
>
> SILO stores a server-side access token for the connection and retains imported
> records according to the retention terms described in this policy. Access to
> imported financial records is restricted by company and finance permissions.
> When AI categorization is used, selected transaction and accounting context may
> be sent to our AI service provider to suggest categories. People review accounting
> decisions before posting; connecting an account does not itself post a journal.
>
> “Stop syncing” pauses retrieval in SILO. It does not revoke the Plaid connection
> or erase previously imported records. Contact us to request permanent revocation
> or deletion, and use the available Plaid or financial-institution controls to
> manage the connection. Some accounting and audit records may need to be retained;
> we will explain the applicable retention and deletion outcome.

Do not publish this verbatim until the request channel, scope, vendor disclosures
and retention terms are confirmed. In particular, add the actual approved
retention terms and provider details; do not claim an operational deletion service
before it can be fulfilled. Refer users to [Plaid's privacy policy](https://plaid.com/legal/#end-user-privacy-policy)
where appropriate, alongside SILO's own notice rather than in place of it.

## Publication evidence

Retain the approved version and reviewer, effective date, deployed public URL,
unauthenticated retrieval/capture, Link-entry notice placement, contact-channel
test and confirmation that the text matches production. Re-check after deployment;
the earlier HTTP 200 only proves the previous notice was reachable.
