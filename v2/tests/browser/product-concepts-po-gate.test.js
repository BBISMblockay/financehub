/* /v2/product-concepts.html: Generate PO only for a concept that is ready.
 *
 * The first live Generate PO (2026-09-30, Bat Bros Youth Hoodie) made one
 * flat 1,400-unit line at $0, because the concept had no sizes, cost or
 * retail. Readiness is decided in the database (product_concepts_v.po_missing,
 * 20260930120000); the page must draw that answer:
 *   1. incomplete: Generate PO disabled, the missing items listed, and a
 *      "Complete in Ask SILO" link bound to the concept with the request
 *      prefilled (never sent)
 *   2. ready: Generate PO links to PO Builder, no checklist, a "PO ready" chip
 *   3. po_missing absent (page deployed before the migration): the button
 *      stays live, since the database function refuses anyway
 */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('product-concepts-po-gate');

const concept = (o) => Object.assign({
  id: 'c-ready', company_entity_id: 'test-company', title: 'Sonic summer tee', status: 'approved',
  phase: 'full_brief', child_count: 0, current_revision_number: 1, created_by: 'test-user',
  suggested_qty: 100, suggested_factory_id: 'fac-1', suggested_factory_name: 'Incotexco',
  suggested_product_type: 'T-Shirts', updated_at: '2026-09-30T00:00:00Z', po_missing: [],
}, o);

const tables = (rows) => ({
  profiles: [{ id: 'test-user', email: 'test@baseballism.com', role: 'owner', active_company_id: null, is_active: true }],
  entity_memberships: [],
  product_concepts_v: rows,
});

const open = async (suite, row) => {
  // The list defaults to Draft, so open by deep link, which selects the
  // concept whatever the filter (the same link Ask SILO's concept cards use).
  return suite.open(`/v2/product-concepts.html?concept=${encodeURIComponent(row.id)}`, tables([row]), {
    ready: () => !!document.querySelector('.pc-detail-actions'),
  });
};

const detail = (page) => page.evaluate(() => {
  const btn = document.getElementById('btnGeneratePO');
  const complete = document.getElementById('btnCompleteConcept');
  const gateEl = document.getElementById('poGate');
  return {
    tag: btn && btn.tagName, disabled: !!(btn && btn.disabled), href: btn && btn.getAttribute('href'),
    completeHref: complete && complete.getAttribute('href'),
    gate: gateEl ? gateEl.textContent.replace(/\s+/g, ' ').trim() : null,
    items: gateEl ? [...gateEl.querySelectorAll('li')].map((li) => li.textContent) : [],
    chips: [...document.querySelectorAll('#detail .ec-chip')].some((n) => n.textContent.trim() === 'PO ready'),
  };
});

(async () => {
  const suite = await startSuite();
  try {
    // 1. Incomplete (the Bat Bros shape).
    {
      const page = await open(suite, concept({ id: 'c-bat', title: 'Bat Bros Youth Hoodie', suggested_qty: 1400,
        po_missing: ['Size breakdown', 'Unit cost (FOB)', 'Retail price'] }));
      const d = await detail(page);
      R.ok('Generate PO is a disabled button, not a link', d.tag === 'BUTTON' && d.disabled && !d.href, JSON.stringify(d));
      R.ok('the missing items are listed, exactly as the database named them',
        JSON.stringify(d.items) === JSON.stringify(['Size breakdown', 'Unit cost (FOB)', 'Retail price']), JSON.stringify(d.items));
      const u = d.completeHref ? new URL(d.completeHref, 'http://x') : null;
      R.ok('Complete in Ask SILO opens this concept', !!u && u.pathname === '/v2/silo-chat.html' && u.searchParams.get('concept') === 'c-bat', d.completeHref);
      R.ok('with the request prefilled, naming what is missing',
        !!u && /Size breakdown/.test(u.searchParams.get('q') || '') && /Retail price/.test(u.searchParams.get('q') || ''), u && u.searchParams.get('q'));
      R.ok('no PO ready chip', !d.chips);
    }

    // 2. Ready.
    {
      const page = await open(suite, concept());
      const d = await detail(page);
      R.ok('Generate PO links to PO Builder for this concept', d.tag === 'A' && d.href === '/v2/po-builder.html?fromConcept=c-ready', JSON.stringify(d));
      R.ok('no checklist and no Complete link', d.gate === null && !d.completeHref, JSON.stringify(d));
      R.ok('the PO ready chip shows', d.chips);
    }

    // 3. Page ahead of the migration.
    {
      const row = concept({ id: 'c-old' });
      delete row.po_missing;
      const page = await open(suite, row);
      const d = await detail(page);
      R.ok('without po_missing the button stays live (the database refuses instead)', d.tag === 'A' && !!d.href, JSON.stringify(d));
      R.ok('and no PO ready claim is made', !d.chips);
    }
  } finally {
    await suite.close();
  }
  process.exit(R.summary().fail ? 1 : 0);
})();
