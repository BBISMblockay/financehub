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

  // po-builder's own vocabulary, in the order the work runs. Used to order the
  // pipeline chart; a status outside it is still counted, at the end.
  const PO_STATUSES = Object.freeze([
    'Draft', 'Approved', 'Sent to Factory', 'Confirmed', 'In Production',
    'Shipped', 'In Transit', 'Partially Received', 'Received', 'Closed', 'Cancelled',
  ]);

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

  // How far back the page looks. The window applies to FINISHED work only --
  // received, closed and cancelled POs, and drafts nobody took further. Open
  // POs are always counted however old they are, because open work does not
  // expire: a PO placed fourteen months ago that has still not arrived is
  // exactly the one somebody needs to see.
  const WINDOWS = Object.freeze([
    { days: 90, label: 'Last 90 days' },
    { days: 365, label: 'Last 12 months' },
    { days: 730, label: 'Last 24 months' },
    { days: null, label: 'All time' },
  ]);
  const DEFAULT_WINDOW_DAYS = 365;
  const resolveWindow = (days) => {
    const wanted = days === null || days === 'all' ? null : Number(days);
    const match = WINDOWS.find((w) => w.days === (Number.isFinite(wanted) ? wanted : -1));
    return match || WINDOWS.find((w) => w.days === (wanted === null ? null : DEFAULT_WINDOW_DAYS));
  };

  const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthKey = (isoDay) => isoDay.slice(0, 7);
  function nextMonth(key) {
    const [y, m] = key.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  const monthLabel = (key) => MONTH_LABEL[Number(key.slice(5, 7)) - 1] + ' ' + key.slice(2, 4);

  // Units and POs per arrival month, over a six-month window: what is already
  // past due, each of the next six months, what lands after them, and what has
  // no arrival date at all. Nothing is dropped -- every open PO is in exactly
  // one bucket, so the buckets sum to the open book.
  function timeline(open, today) {
    const dated = open.filter((p) => day(p.effective_arrival_date));
    const first = today || dated.map((p) => day(p.effective_arrival_date)).sort()[0] || null;
    const bucket = () => ({ units: 0, pos: 0 });
    const out = {
      pastDue: bucket(),
      later: bucket(),
      undated: bucket(),
      months: [],
    };
    if (first) {
      let key = monthKey(first);
      for (let i = 0; i < 6; i += 1) {
        out.months.push({ key, label: monthLabel(key), ...bucket() });
        key = nextMonth(key);
      }
    }
    const lastKey = out.months.length ? out.months[out.months.length - 1].key : null;
    for (const p of open) {
      const date = day(p.effective_arrival_date);
      let target;
      if (!date) target = out.undated;
      else if (today && date < today) target = out.pastDue;
      else {
        const key = monthKey(date);
        target = out.months.find((m) => m.key === key)
          || (lastKey && key > lastKey ? out.later : out.months[0] || out.later);
      }
      target.units += num(p.total_units);
      target.pos += 1;
    }
    return out;
  }

  function addDays(isoDay, days) {
    const d = new Date(isoDay + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /* Pure model. `facts` holds exactly what load() read; `today` is the
     company's own business date, or null when it could not be resolved (then
     the windows that need it report null rather than guessing from the
     browser's clock). */
  function assess(facts, { company = null, today = null, currency = null,
    windowDays = null, cutoff = null } = {}) {
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
      const row = byFactory.get(name) || { factory: name, pos: 0, units: 0, cost: 0 };
      row.pos += 1;
      row.units += num(p.total_units);
      row.cost += num(p.total_estimated_cost);
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
      // The period the finished work is counted over. `cutoff` is null when
      // it could not be applied (no business date, or All time), and then the
      // page says "All time" rather than implying a window it did not use.
      windowDays: cutoff ? windowDays : null,
      cutoff,
      // PO Builder: what is being written and what is live, plus where the
      // whole book sits in the workflow.
      builder: {
        drafts: drafts.length,
        open: open.length,
        total: pos.length,
        byStatus: (() => {
          const counts = new Map();
          for (const p of pos) {
            const key = p.status || 'Unknown';
            const row = counts.get(key) || { status: key, count: 0, units: 0 };
            row.count += 1;
            row.units += num(p.total_units);
            counts.set(key, row);
          }
          return Array.from(counts.values()).sort((a, b) => {
            const ia = PO_STATUSES.indexOf(a.status);
            const ib = PO_STATUSES.indexOf(b.status);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.status.localeCompare(b.status);
          });
        })(),
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
        timeline: timeline(open, today),
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
          .slice(0, 5),
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
  async function allRows(db, table, columns, order, configure = (q) => q) {
    const rows = [];
    let expected = null;
    for (;;) {
      const response = await result(configure(db.from(table).select(columns, { count: 'exact' }))
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

  async function load({ db, config = window.__SILO_CONFIG__, windowDays = DEFAULT_WINDOW_DAYS }) {
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

    // The window is measured from the company's own business date. Without
    // one there is no honest cutoff, so the page reads everything and says
    // "All time" rather than cutting history against the browser's clock.
    const period = resolveWindow(windowDays);
    const cutoff = period.days !== null && today ? addDays(today, -period.days) : null;
    // Bounded by construction: a PO created before the cutoff is read only
    // while it is still open. `po_created_at` is always set; `order_date` is
    // not, and a null there would quietly drop rows from the window.
    //
    // Two reads merged by id, rather than one `.or(...)` carrying an `in.(…)`
    // of statuses with spaces in them: PostgREST's or() grammar needs those
    // values quoted and any comma escaped, and getting it subtly wrong
    // silently returns the WRONG SET rather than erroring. Both filters here
    // are the plain forms used across the rest of this app.
    const PO_COLUMNS = 'id,po_name,factory_name,status,total_units,total_estimated_cost,'
      + 'effective_arrival_date,arrival_variance_days,arrival_state,shipment_count,'
      + 'status_conflicts_with_shipments';
    async function readPos() {
      if (!cutoff) return allRows(db, 'v_po_incoming_summary', PO_COLUMNS, 'id');
      const [recent, open] = await Promise.all([
        allRows(db, 'v_po_incoming_summary', PO_COLUMNS, 'id',
          (q) => q.gte('po_created_at', cutoff)),
        allRows(db, 'v_po_incoming_summary', PO_COLUMNS, 'id',
          (q) => q.in('status', OPEN_STATUSES)),
      ]);
      const byId = new Map();
      for (const row of recent.concat(open)) byId.set(row.id, row);
      return Array.from(byId.values());
    }

    const jobs = {
      pos: readPos,
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
    return assess(facts, {
      company, today, currency: facts.currency || null,
      windowDays: period.days, cutoff,
    });
  }

  async function boot({ active, crumbs, onModel, onError, windowDays = DEFAULT_WINDOW_DAYS,
    config = window.__SILO_CONFIG__, db: providedDb } = {}) {
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
      let selected = windowDays;
      const controller = {
        db,
        company: null,
        get windowDays() { return selected; },
        async refresh(nextWindow) {
          const token = ++generation;
          if (nextWindow !== undefined) selected = nextWindow;
          try {
            const model = await load({ db, config, windowDays: selected });
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
    OPEN_STATUSES, PO_STATUSES, ARRIVAL_STATE_LABEL, PHASE_LABEL,
    WINDOWS, DEFAULT_WINDOW_DAYS, resolveWindow,
    timeline, assess, load, boot,
  };
})();
