-- Generate PO from a concept: close the duplicate-PO race (PR #830
-- supplemental review, 2026-09-30).
--
-- v2/po-builder.html?fromConcept=<id> checked po_concept_links for an
-- existing link, and if none, created a NEW po_headers row, inserted lines,
-- then inserted the link -- three separate client-driven statements, none
-- of them atomic with each other. Two concurrent callers (two tabs, or a
-- double-click) that both read "no link yet" before either writes each
-- independently create their OWN po_headers row and their OWN lines; the
-- LATER po_concept_links insert only de-duplicates the LINK (its unique
-- constraint is (po_header_id, concept_id), which differs across the two
-- headers and so does not fire), leaving two real, wasteful POs with real
-- (duplicated) quantities. Reproduced by the supplemental reviewer running
-- the committed functions against a mocked store enforcing that exact
-- constraint: two concurrent first requests produced two POs / two lines /
-- two links for one concept.
--
-- The fix closes the race at the EARLIEST possible point -- the po_headers
-- INSERT itself -- rather than trying to make three separate client round
-- trips atomic after the fact (which would need a claims table spanning
-- multiple HTTP calls, the pattern used elsewhere in this schema for
-- exactly that harder problem -- e.g. stripe_connect_setup_claims,
-- billing_checkout_claims -- but unnecessary here because the FIRST write
-- in this sequence, the po_headers insert, can itself carry the claim).
-- generated_from_concept_id records which concept a PO was the PRIMARY
-- generation target for. A PARTIAL unique index (only where non-null) means
-- inserting a second po_headers row for the same concept via this path
-- fails with a 23505 unique-violation -- Postgres decides the race, not a
-- client-side check-then-act sequence, and whichever insert loses can look
-- up the winner's row directly rather than creating a duplicate.
--
-- Deliberately NOT a constraint on po_concept_links (that table's
-- many-to-many model -- several concepts combined into one PO via the
-- existing modal picker -- is correct and unrelated; a concept added to an
-- open PO through that picker never sets this column). Deliberately NOT
-- scoped by company_entity_id: a product_concepts.id is already unique to
-- exactly one company, so a bare unique index on the column is sufficient
-- and correct -- no two companies can ever legitimately share a concept id.

alter table public.po_headers
  add column if not exists generated_from_concept_id uuid references public.product_concepts(id);

create unique index if not exists po_headers_generated_from_concept_uniq
  on public.po_headers (generated_from_concept_id)
  where generated_from_concept_id is not null;

comment on column public.po_headers.generated_from_concept_id is
  'Set only by the Generate PO deep link (/v2/po-builder.html?fromConcept=). '
  'The partial unique index above is the idempotency guard against a '
  'concurrent duplicate generation for the same concept -- see '
  '20260930000000_generate_po_from_concept_uniq.sql.';
