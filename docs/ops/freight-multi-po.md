# Freight requests shared across several POs

**Status (2026-10-08):** phase 1 implemented (Costing no longer misses a shared request, and never
prefills a shared invoice's full amount into one PO). Phase 2 is **planned, not built**: its
migration needs Blake's approval before it is written to production. Nothing here has been verified
against production data beyond the read-only counts below.

## The problem

One forwarder invoice often covers a consolidated shipment of several POs. Both payment-request
intake pages (`v2/purchase_request.html`'s PO picker, `v2/payment-request2-core.js`) store the POs a
request covers as **one text value**, `payment_requests.internal_po_number`, joined with `", "`
(e.g. `Creytex-329-s, Creytex-330, Creytex-331`). The manual fallback and the legacy import can hold
any typed text. Nothing links a request to `po_headers` rows: there is no request-to-PO table and no
PO column other than that text (checked against `information_schema` and every migration on `main`).

`v2/po-costing.html` prefilled freight with `.eq('internal_po_number', poName)`. That is an exact
match on the whole string, so a shared request never matched any of its POs.

Read-only production counts (2026-10-08): **15** `inventory_freight` requests, **2** naming more than
one PO.

Readers of `internal_po_number` that any change must keep working: Request Manager (search, list
meta, detail drawer), the `payment-request-forward-melio` email, and Costing.

## Phase 1: Costing reads a shared request correctly (this PR, no migration)

`v2/freight-request-match.js` (tested by `v2/tests/unit/freight-request-match.test.js`), wired into
`v2/po-costing.html`:

- The request's text is split on commas and compared **exactly** (after trimming) with the PO name.
  `PO-33` never matches a request for `PO-330`.
- A request naming **only this PO** behaves as before: it prefills the amount, the reference and the
  carrier.
- A request naming **this PO and others** prefills the reference and carrier only. It never fills in
  the amount, which would overstate landed cost once per PO. It shows a notice naming the other POs
  and pointing to the page's existing **Combined shipment** wizard. That wizard splits one bill
  across POs (FOB-proportional, per unit or by weight), previews each share and saves on Apply.
- Nothing typed is overwritten, and an answer that arrives after the user has switched PO is
  dropped.
- The lookup pages through every freight request; there is no row cap. If a page fails, the PO
  still open shows "Could not check freight requests for this PO, so nothing was prefilled", so a
  failure never looks like "no request exists". Each form fill (opening a PO, reopening the same
  one, saving) retires any lookup still in flight, so a late answer never paints an error over a
  prefill, a prefill under an error, or anything after freight was saved. Covered by
  `v2/tests/browser/po-costing-freight.test.js`.
- The query stays company-scoped (`company_entity_id`, plus RLS), and the page writes nothing new.

What phase 1 does **not** do:

- record which request a PO's freight came from;
- check that the shares saved across a shared invoice's POs add up to the invoice;
- link requests to `po_headers` rows.

## Phase 2: link requests to POs and record the allocation (planned)

### Proposed shape (to confirm before writing the migration)

- **`payment_request_po_links`**
  - **Columns:** `id`, `company_entity_id`, `payment_request_id` (FK, cascade), `po_header_id` (FK),
    `allocated_amount numeric(14,2)` (null until allocated), `allocation_method`
    (`manual` / `proportional` / `per_unit` / `weight`), `allocated_by` / `allocated_at`,
    `approved_by` / `approved_at`.
  - **Uniqueness:** unique on `(payment_request_id, po_header_id)`.
  - **Tenant integrity:** composite FKs so a link cannot pair a request and a PO from different
    companies.
- **RLS**
  - **Read:** `company_entity_id = active_company_id()`, the same as `payment_requests`.
  - **Write:** the AP gate (`current_user_can_manage_payment_requests()`) or the PO writers
    (`po_builder_can_write()`). Which one is decision 1.
  - **Company stamp:** end the migration with `attach_stamp_company_entity_id_triggers()`.
- **Invariants**
  - An **approved** allocation's links must sum to the request's `amount_due` to the cent. This is
    enforced by a deferred constraint trigger, like `card_splits_must_tie`.
  - Changing the request amount or the PO set clears approval.
  - A single-PO request's link carries the full amount, with no allocation step.
- **Intake** keeps writing `internal_po_number` exactly as today, since four readers depend on it.
  It also writes one link row per **picked** PO, carrying the PO's id. Free-typed text (the manual
  fallback) creates no links and is listed as "unlinked".
- **Costing** prefills from the PO's own **approved** link. If a PO's link is not yet allocated or
  approved, Costing shows the request and its state and never fills in a number.
- **Combined shipment** gains a "from freight request" start. It loads the request's POs and amount,
  and Apply writes the allocations as **proposed**; approval is a separate step by the AP gate. The
  wizard's existing FOB/unit/weight math is reused, not rewritten.
- **Backfill**, which needs Blake's approval:
  - Link each existing request whose names match `po_headers.po_name` exactly within its own
    company.
  - Single-PO requests (13 of 15) get the full amount, recorded as approved by the backfill.
  - The 2 shared requests get links with **no** amount, for a person to allocate.
  - Names that match no PO are reported, never guessed.

### Acceptance criteria (proposed)

1. A request naming several POs appears in Costing on every one of them.
2. No PO's freight is ever prefilled from a shared request until that PO's share is **approved**.
3. Approved shares of one request always sum to its amount to the cent. An attempt that does not
   is refused by the database, not only by the page.
4. Links, allocations and approvals stay in their own company. An impersonation test covers two
   companies.
5. Request Manager, the Melio forward email and both intake pages behave exactly as today for
   single-PO requests (regression tests on each).
6. Every allocation records who proposed it, who approved it and when. An approved allocation is
   changed only by un-approving it.
7. The backfill produces no link for a name it cannot match exactly, and lists those names.
8. `verify_v2_schema.sql` gains a check for the table, its RLS and the sum invariant.

### Decisions needed from Blake before phase 2 is built

1. **Who allocates and who approves:** AP (`current_user_can_manage_payment_requests()`),
   purchasing (`po_builder_can_write()`), or one proposes and the other approves.
   - The AP gate passes for **any** membership `admin`, which is nearly everyone at Baseballism.
   - If approval should be narrower, it needs a narrower gate, for example the finance population
     `can_manage_journal_entries()` uses.
2. **Default split method:** FOB-proportional, per unit or by weight.
3. **Request statuses:** whether rejected or cancelled freight requests should still prefill.
   Today any status does, and phase 1 keeps that.
4. **Apply before approval:** whether Costing may apply a proposed, unapproved share, or must wait.
