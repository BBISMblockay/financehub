# Freight requests shared across several POs

**Status (2026-11-28): built, as the freight bank — see "What was built" at the end.** Phase 1
(below) was replaced wholesale: `v2/freight-request-match.js` and its tests are deleted, and Costing
no longer prefills a number from a payment request at all. The phase 2 proposal below is kept as the
record of what was considered, and the final section says where the built design differs from it and
why. The counts and the readers listed here are still accurate.

## The problem

One forwarder invoice often covers a consolidated shipment of several POs. Both payment-request
intake pages (`v2/purchase_request.html`'s PO picker, `v2/payment-request2-core.js`) store the POs a
request covers as **one text value**, `payment_requests.internal_po_number`, joined with `", "`
(e.g. `Creytex-329-s, Creytex-330, Creytex-331`). The manual fallback and the legacy import can hold
any typed text. Nothing links a request to `po_headers` rows: there is no request-to-PO table and no
PO column other than that text (checked against `information_schema` and every migration on `main`).

`v2/po-costing.html` prefilled freight with `.eq('internal_po_number', poName)`. That is an exact
match on the whole string, so a shared request never matched any of its POs.

Read-only production counts (2026-10-08): **15** `inventory_freight` requests, **2** listing more than
one name: one names two POs (`MasterCap-82, MasterCap-78-S`); the other is one PO followed by a typed
description after a comma, which the manual fallback allows.

Readers of `internal_po_number` that any change must keep working: Request Manager (search, list
meta, detail drawer), the `payment-request-forward-melio` email, and Costing.

## Phase 1: Costing reads a shared request correctly (this PR, no migration)

`v2/freight-request-match.js` (tested by `v2/tests/unit/freight-request-match.test.js`), wired into
`v2/po-costing.html`:

- The request's text is split on commas and compared **exactly** (after trimming) with the PO name.
  `PO-33` never matches a request for `PO-330`.
- A request naming **only this PO** behaves as before: it prefills the amount, the reference and the
  carrier.
- A request naming **this PO and more** prefills the reference and carrier only. It never fills in
  the amount, which would overstate landed cost once per PO. It shows a notice quoting what else the
  request lists, because the manual fallback allows free text after a comma (one production request
  is a PO followed by a description). The notice offers both readings: split it with the page's
  existing **Combined shipment** wizard, or enter the full amount if it covers only this PO. That
  wizard splits one bill across POs (FOB-proportional, per unit or by weight), previews each share
  and saves on Apply.
- The **newest** request naming the PO wins, as before. If a newer request lists more than this PO
  and an older one names only it, Costing now shows the notice and no amount, where it used to
  prefill the older single-PO amount. No such pair exists in production today.
- Nothing typed is overwritten, and an answer that arrives after the user has switched PO is
  dropped.
- The lookup pages through every freight request; there is no row cap. Only an empty page ends it,
  so a server that returns fewer rows than asked cannot cut it short. If a page fails, the PO
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

## Update 2026-10-28: the booking now exists, so phase 2 should hang off it

`20261028220000_shipment_bookings_and_po_arrival.sql` added `shipment_bookings`
(a forwarder booking / container) with `incoming_shipments.booking_id`. A
consolidated shipment is therefore now one row with one set of dates and a known
set of POs, which is exactly what a shared forwarder invoice covers.

So when phase 2 below is built, `payment_request_po_links` should carry a
nullable `shipment_booking_id`: a deposit or invoice attaches to the **booking**,
the booking already knows its POs and their units, and the split is proposed
from that instead of being parsed out of `internal_po_number`. The four
decisions below are unchanged and still needed first. Nothing in phase 1
changed.

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
  - Requests listing more than one name (2 of 15; one is a PO plus typed text) get links only for
    names that match a PO, with **no** amount, for a person to allocate or confirm.
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


---

## What was built, 2026-11-28 (`20261128040000_landed_cost_bill_bank.sql`)

Blake set the shape: *"Can you create a bank of freight from purchase requests and not allow that to
happen in costing and if user tries to use walk the math how it needs to go for multi shipment
chaos."*

**The bill is the object, and it is spent.** Every `inventory_freight` payment request becomes a row
in `landed_cost_bills`, kept in step by an AFTER trigger on `payment_requests`. Costing has no
freight field any more: Step 3 of `/v2/po-costing.html` lists the bills on this PO and their shares,
and the only way to add freight is ALLOCATE A BILL. Nobody can type a freight total, so nobody can
type the same invoice onto four POs — which is how $27,502 came to be counted twice on production.

**Allocation is to a container, not a PO.** `landed_cost_allocations` is one row per (bill, PO) or
(bill, PO, shipment). A consolidated container carrying four POs is four rows off one invoice; a PO
that shipped in two containers takes each container's bill on that container's units only, which is
the multi-shipment case that had no representation before. `shipment_id` null still means the whole
PO, so a company that does not record shipments is unaffected.

**The database refuses an overspend, not the page.** `zz_landed_cost_allocation_guard` takes
`for update` on the bill and refuses any row that would put the allocated total over it, so two
people allocating at once cannot both pass. `silo_allocate_landed_cost_bill()` re-states a bill's
whole split in one transaction, so a refusal leaves the previous split intact.

**The math is walked.** The wizard is four steps — the bill, what it paid for, the split, review —
and the split step shows every target with its units, factory value, share and resulting per-unit
figure before anything is written, by factory value, per unit, or by hand. The shares are allocated
to the cent by largest remainder, so they always total the invoice.

### Where this differs from the phase 2 proposal above, and why

| Proposed | Built | Why |
|---|---|---|
| `payment_request_po_links` with an `allocated_amount` | `landed_cost_bills` + `landed_cost_allocations` | A link table makes the request the object. The bill is the object: it has a balance, and the question people actually ask is "is this invoice fully spent, and where did it go" |
| Links to POs | Allocations to POs **and shipments** | The PO is not the thing freight is paid for; the container is. Without that dimension a PO shipped twice can only have one freight number, which is the root cause the audit found |
| A separate approve step, summing to the request's amount | No approval step; the guard refuses an overspend outright | The decision was already made when the payment request was approved and paid. A second approval on the allocation is bookkeeping for the same money. An under-allocated bill is a legitimate in-progress state and is shown as `partial`, not blocked |
| Costing prefills from an approved link | Costing has no freight field | Decision 4 above is moot: there is nothing to prefill into |
| Decision 1 (who allocates) | `po_costing_can_write()` | Allocation is costing, and that is already the narrow gate on the costing tables |
| Decision 2 (default split) | By factory value, changeable per bill | Matches what the Combined Shipment wizard already defaulted to |
| Decision 3 (statuses) | Every `inventory_freight` request becomes a bill, whatever its status | The bill carries its request's state; hiding a cancelled one would hide money someone had already allocated |

### Backfill

**No number moves.** Every `inventory_freight` request becomes a bill. Each existing
`po_costing.freight_amount` is then allocated to the matching paid bill if that bill has room, and
otherwise to a `legacy` bill created for exactly that amount — so a PO keeps the freight it had, and
a duplicate shows up as a `legacy` bill sitting beside the paid one rather than being silently
rewritten. Reconciling those is a person's job, with the balances visible.

The migration also restores `po_lines.unit_cost` on the 134 lines (17 POs) the old "push landed cost
to PO lines" default had overwritten with the landed unit, from `po_costing_lines.fob_unit`, and only
where the two still agree to within half a cent — a line edited since is left alone. That default is
deleted, not just unticked.
