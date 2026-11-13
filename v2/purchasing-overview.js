/* Shared read-only Purchasing overview model.
 *
 * One page, no writes: it reads what the four Purchasing tabs already read and
 * says, per tab, what is worth looking at. Every figure here is a count or a
 * sum of rows the tab itself shows, so the Overview can never disagree with
 * the page it links to.
 *
 * Reads (all RLS-scoped, SELECT only):
 *   v_po_incoming_summary   PO-level units, estimated cost, arrival state
 *   v_po_costing_summary    which costing phase each PO has reached
 *   factories               how many factories exist
 *   company_settings        the currency the company declares it reports in
 *
 * The two views are security_invoker and expose no company_entity_id column,
 * so RLS is the tenant scope, exactly as po-report.html and po-costing.html
 * already rely on it. `factories` does carry the column, so that read filters
 * on the active company as well.
 *
 * Nothing here is company-specific: the status vocabulary is po-builder's own
 * PO_STATUSES, shared with po-report.html.
 */
(function () {
  'use strict';

  // The same open/production split po-report.html uses, so "open" means the
  // same thing on both pages.
  const OPEN_STATUSES = Object.freeze([
    'Approved', 'Sent to Factory', 'Confirmed', 'In Production',
    'Shipped', 'In Transit', 'Partially Received',
  ]);
  const DRAFT_STATUS = 'Draft';

  const ARRIVAL_STATE_LABEL = Object.freeze({
    unknown: 'No shipment logged',
    not_shipped: 'Not shipped',
    booked: 'Booked',
    in_transit: 'In transit',
    partially_received: 'Part received',
    received: 'Received',
  });

  const PHASE_LABEL = Object.freeze({
    fob: 'FOB & factory invoice',
    freight: 'Awaiting freight',
    final: 'Landed',
  });

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
  const day = (v) => (isDate(v) ? v.slice(0, 10) : null);

  function addDays(isoDay, days) {
    const d = new Date(isoDay + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /* Pure model. `facts` holds exactly what load() read; `today` is the
     company's own business date, or null when it could not be resolved (then
     the windows that need it report null rather than guessing from the
     browser's clock). */
  function assess(facts, { company = null, today = null, currency = null } = {}) {
    const pos = Array.isArray(facts.pos) ? facts.pos : [];
    const costing = Array.isArray(facts.costing) ? facts.costing : null;
    const open = pos.filter((p) => OPEN_STATUSES.includes(p.status));
    const drafts = pos.filter((p) => p.status === DRAFT_STATUS);

    const horizon = today ? addDays(today, 30) : null;
    const arriving = open
      .filter((p) => day(p.effective_arrival_date))
      .sort((a, b) => day(a.effective_arrival_date).localeCompare(day(b.effective_arrival_date)));

    const late = today
      ? arriving.filter((p) => day(p.effective_arrival_date) < today)
      : arriving.filter((p) => num(p.arrival_variance_days) > 0);

    const byFactory = new Map();
    for (const p of open) {
      const name = p.factory_name || 'No factory';
      const row = byFactory.get(name) || { factory: name, pos: 0, units: 0 };
      row.pos += 1;
      row.units += num(p.total_units);
      byFactory.set(name, row);
    }

    const phaseOf = new Map();
    if (costing) for (const c of costing) phaseOf.set(c.po_header_id, c.phase || null);
    const phaseCount = (want) => (costing
      ? open.filter((p) => (phaseOf.get(p.id) || null) === want).length
      : null);

    return {
      company,
      today,
      // The currency the company declares it reports in. null means "not
      // declared" -- then every amount is shown as a bare number rather than
      // asserting a currency nobody chose.
      currency,
      // PO Builder: what is being written and what is live.
      builder: {
        drafts: drafts.length,
        open: open.length,
        total: pos.length,
      },
      // PO Report: what is coming in.
      incoming: {
        units: open.reduce((sum, p) => sum + num(p.total_units), 0),
        estimatedCost: open.reduce((sum, p) => sum + num(p.total_estimated_cost), 0),
        late: late.length,
        noShipment: open.filter((p) => !num(p.shipment_count)).length,
        conflicts: open.filter((p) => p.status_conflicts_with_shipments === true).length,
        next30: horizon
          ? arriving.filter((p) => day(p.effective_arrival_date) >= today
            && day(p.effective_arrival_date) <= horizon).length
          : null,
        undated: open.filter((p) => !day(p.effective_arrival_date)).length,
        rows: arriving.slice(0, 6).map((p) => ({
          id: p.id,
          name: p.po_name || 'Untitled PO',
          factory: p.factory_name || null,
          date: day(p.effective_arrival_date),
          units: num(p.total_units),
          state: ARRIVAL_STATE_LABEL[p.arrival_state] || ARRIVAL_STATE_LABEL.unknown,
          late: today ? day(p.effective_arrival_date) < today : num(p.arrival_variance_days) > 0,
        })),
      },
      // Landed Cost: how far costing has got on the open book.
      costing: {
        state: costing ? 'known' : 'unknown',
        notStarted: phaseCount(null),
        fob: phaseCount('fob'),
        freight: phaseCount('freight'),
        final: phaseCount('final'),
      },
      // Factories: who is making it.
      factories: {
        state: Number.isInteger(facts.factoryCount) ? 'known' : 'unknown',
        count: Number.isInteger(facts.factoryCount) ? facts.factoryCount : null,
        withOpen: byFactory.size,
        rows: Array.from(byFactory.values())
          .sort((a, b) => b.units - a.units || a.factory.localeCompare(b.factory))
          .slice(0, 4),
      },
      errors: facts.errors || [],
    };
  }

  async function result(query) {
    const response = await query;
    if (response.error) throw new Error(response.error.message || 'Read failed');
    return response;
  }

  // Page through a view in 500-row windows, with the exact count checked each
  // time: a partial read must fail loudly rather than quietly undercount a
  // figure someone will plan a purchase on.
  async function allRows(db, table, columns, order) {
    const rows = [];
    let expected = null;
    for (;;) {
      const response = await result(db.from(table).select(columns, { count: 'exact' })
        .order(order).range(rows.length, rows.length + 499));
      if (!Array.isArray(response.data) || !Number.isInteger(response.count)) {
        throw new Error('Could not verify the full row count');
      }
      if (expected !== null && expected !== response.count) {
        throw new Error('Records changed during this read. Refresh to retry.');
      }
      expected = response.count;
      rows.push(...response.data);
      if (rows.length >= expected) return rows.slice(0, expected);
      if (!response.data.length) throw new Error('Incomplete read. Refresh to retry.');
    }
  }

  async function load({ db, config = window.__SILO_CONFIG__ }) {
    // Resolve on every refresh. Never trust a company ID from URL/sessionStorage.
    const company = await config?.ensureActiveCompany?.(db);
    if (!company?.id) throw new Error('Select a company first');
    if (company._staleReconcile) throw new Error('Company could not be reconciled. Refresh to retry.');

    const errors = [];
    let today = null;
    try { today = (await result(db.rpc('silo_business_today'))).data; } catch (error) {
      errors.push({ source: 'today', message: error.message });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '')) today = null;

    const jobs = {
      pos: () => allRows(db, 'v_po_incoming_summary',
        'id,po_name,factory_name,status,total_units,total_estimated_cost,'
        + 'effective_arrival_date,arrival_variance_days,arrival_state,shipment_count,'
        + 'status_conflicts_with_shipments', 'id'),
      costing: () => allRows(db, 'v_po_costing_summary', 'po_header_id,phase', 'po_header_id'),
      currency: async () => {
        const r = await result(db.from('company_settings').select('default_currency')
          .eq('company_entity_id', company.id).maybeSingle());
        return /^[A-Z]{3}$/.test(r.data?.default_currency || '') ? r.data.default_currency : null;
      },
      factoryCount: async () => {
        const r = await result(db.from('factories').select('id', { count: 'exact', head: true })
          .eq('company_entity_id', company.id));
        if (!Number.isInteger(r.count)) throw new Error('Could not count factories');
        return r.count;
      },
    };
    const facts = { errors };
    await Promise.all(Object.entries(jobs).map(async ([key, read]) => {
      try { facts[key] = await read(); } catch (error) {
        facts[key] = undefined;
        errors.push({ source: key, message: error.message });
      }
    }));

    // A different tab can change the server's active company during parallel
    // reads. Never render a mixed snapshot as if it belonged to this company.
    const current = await config.ensureActiveCompany(db);
    if (current?._staleReconcile) throw new Error('Company could not be reconciled. Refresh to retry.');
    if (current?.id !== company.id) throw new Error('Company changed while loading. Refresh to retry.');
    if (facts.pos === undefined) {
      throw new Error(errors.find((e) => e.source === 'pos')?.message || 'Could not read purchase orders');
    }
    return assess(facts, { company, today, currency: facts.currency || null });
  }

  async function boot({ active, crumbs, onModel, onError, config = window.__SILO_CONFIG__, db: providedDb } = {}) {
    let errorReported = false;
    try {
      if (!providedDb && (!config?.SUPABASE_URL || !config?.SUPABASE_ANON_KEY)) throw new Error('Missing Supabase config');
      const db = providedDb || window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
      const session = await result(db.auth.getSession());
      if (!session.data?.session) {
        window.location.href = '/pages/login.html?next=' + encodeURIComponent(window.location.pathname + window.location.search);
        return null;
      }
      let generation = 0;
      const controller = {
        db,
        company: null,
        async refresh() {
          const token = ++generation;
          try {
            const model = await load({ db, config });
            if (token !== generation) return null;
            controller.company = model.company;
            onModel?.(model);
            return model;
          } catch (error) {
            if (token === generation) { errorReported = true; onError?.(error); }
            throw error;
          }
        },
      };
      window.SiloChrome?.mount({
        appEl: '#silo-app', active, user: { email: session.data.session.user.email }, crumbs, supabaseClient: db,
      });
      await controller.refresh();
      return controller;
    } catch (error) {
      if (!errorReported) onError?.(error);
      throw error;
    }
  }

  window.SiloPurchasingOverview = {
    OPEN_STATUSES, ARRIVAL_STATE_LABEL, PHASE_LABEL, assess, load, boot,
  };
})();
