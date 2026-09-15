/* Where this company actually is, moving its books from QuickBooks into Silo.
 *
 * Four rules hold this file together. Break one and the visual becomes
 * decoration that outranks the data it claims to summarise:
 *
 *  1. EVERY STEP IS DERIVED, never asserted. Nothing here is a checkbox a
 *     person ticks, and there is no table recording "we finished step 3".
 *     A step's state is recomputed from the rows that would have to exist for
 *     it to be true, so it cannot drift away from the books.
 *
 *  2. UNKNOWN IS NOT DONE. A fact that could not be read is `UNMEASURED`, and
 *     a step resting on one renders "Unknown" — never "Done", and never
 *     silently skipped. `null` means measured-and-absent; `UNMEASURED` means
 *     not measured. They are different answers and they look different.
 *
 *  3. EACH STEP SAYS WHAT IT CANNOT PROVE. Retained history proves the
 *     reports tie out, not that every source document was kept; connected
 *     feeds prove which accounts reach Silo, not that they are all of them.
 *     The limit ships beside the number, in the same panel, not in a footnote.
 *
 *  4. STATE IS IN WORDS, not only in colour. The state label is real text in
 *     the button, so it survives a screenshot, a colourblind reader and a
 *     printout.
 *
 * `assess()` is pure and takes plain facts, so the whole decision table is
 * unit-testable without a browser or a database. `mount()` only gathers those
 * facts and draws the result.
 */
(function () {
  'use strict';

  /* Measured-and-absent is `null`. Not measured at all is this. */
  const UNMEASURED = Object.freeze({ unmeasured: true });
  const isUnmeasured = v => !!(v && v.unmeasured === true);

  const STATES = Object.freeze({
    done: 'Done',
    attention: 'Needs attention',
    active: 'In progress',
    todo: 'Not started',
    unknown: 'Unknown',
  });

  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const count = n => Number(n || 0).toLocaleString('en-US');
  const plural = (n, one, many) => `${count(n)} ${Number(n) === 1 ? one : (many || one + 's')}`;

  /* ---- dates -------------------------------------------------------------
     Every date here is an ISO 'YYYY-MM-DD' string and stays one. Arithmetic
     goes through UTC so a browser east or west of the company never shifts a
     period boundary by a day. */
  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  function addDays(iso, n) {
    if (!isDate(iso)) return null;
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const monthOf = iso => (isDate(iso) ? iso.slice(0, 7) : null);
  function monthsFrom(startIso, endIso) {
    const from = monthOf(startIso); const to = monthOf(endIso);
    if (!from || !to || from > to) return [];
    const out = []; let y = Number(from.slice(0, 4)); let m = Number(from.slice(5, 7));
    for (let guard = 0; guard < 600; guard += 1) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      out.push(key);
      if (key === to) return out;
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }

  /* ---- history coverage --------------------------------------------------
     Saved windows are allowed to overlap and to repeat: each snapshot stands
     alone, and re-saving the same period is normal. Merging first is what
     makes "is anything missing" answerable at all -- two identical windows are
     one period of coverage, not two. Adjacent windows (one ending the day the
     next begins) merge too, or a clean hand-off would read as a gap. */
  function mergeWindows(windows) {
    const clean = (windows || [])
      .filter(w => w && isDate(w.period_start) && isDate(w.period_end) && w.period_start <= w.period_end)
      .map(w => ({ start: w.period_start, end: w.period_end }))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const merged = [];
    for (const w of clean) {
      const last = merged[merged.length - 1];
      if (last && w.start <= addDays(last.end, 1)) { if (w.end > last.end) last.end = w.end; continue; }
      merged.push({ start: w.start, end: w.end });
    }
    return merged;
  }

  /* Coverage is judged against the day before Silo takes over, because that is
     the only end date the archive is responsible for. How far BACK history
     should reach is a business decision Silo cannot read, so `from` is
     reported and never graded. */
  function coverage(windows, cutoverIso) {
    const merged = mergeWindows(windows);
    const target = addDays(cutoverIso, -1);
    if (!merged.length || !target) {
      return { merged, target, from: null, to: null, gaps: [], covered: false, beyond: 0 };
    }
    const gaps = [];
    for (let i = 1; i < merged.length; i += 1) {
      const from = addDays(merged[i - 1].end, 1);
      const to = addDays(merged[i].start, -1);
      if (from <= target) gaps.push({ from, to: to > target ? target : to });
    }
    const end = merged[merged.length - 1].end;
    if (end < target) gaps.push({ from: addDays(end, 1), to: target });
    return {
      merged,
      target,
      from: merged[0].start,
      to: end,
      gaps,
      covered: !gaps.length,
      beyond: merged.filter(w => w.end > target).length,
    };
  }

  /* Each snapshot stands alone: re-saving a period produces a second row with
     its own full exception count, and two snapshots of one January are 71
     exceptions, not 142. Anything summed across snapshots therefore has to run
     over a NON-OVERLAPPING selection first. Newest wins for an identical
     window; the widest wins where windows differ, because the figure a reader
     acts on should describe as much of the archive as one snapshot can. */
  function independentSnapshots(rows) {
    const newestPerWindow = new Map();
    for (const row of rows || []) {
      if (!row || !isDate(row.period_start) || !isDate(row.period_end)) continue;
      const key = row.period_start + '|' + row.period_end;
      const held = newestPerWindow.get(key);
      if (!held || String(row.created_at || '') > String(held.created_at || '')) newestPerWindow.set(key, row);
    }
    const span = r => new Date(r.period_end + 'T00:00:00Z') - new Date(r.period_start + 'T00:00:00Z');
    const ranked = Array.from(newestPerWindow.values()).sort((a, b) =>
      (span(b) - span(a)) || (String(b.created_at || '') > String(a.created_at || '') ? 1 : -1));
    const kept = [];
    for (const row of ranked) {
      const overlaps = kept.some(k => row.period_start <= k.period_end && k.period_start <= row.period_end);
      if (!overlaps) kept.push(row);
    }
    return { kept, setAside: (rows || []).length - kept.length };
  }

  /* ---- the steps ---------------------------------------------------------
     Each builder returns {state, summary, points, limit, metrics}. `points`
     are sentences a person reads; `limit` is the one sentence saying what this
     step does NOT establish. Both are required -- a step with no stated limit
     is a step overclaiming. */

  function feedsStage(f) {
    const link = { href: 'transactions.html', text: 'Review feeds and sources' };
    if (isUnmeasured(f.bank) || isUnmeasured(f.sources)) {
      return { state: 'unknown', summary: 'Feed status could not be read', link,
        points: ['Silo could not read your bank connections or card sources on this load. Refresh the page; if it keeps happening, tell your administrator before treating any step below as current.'],
        limit: 'Nothing here is a claim that no feeds exist — only that none could be read.' };
    }
    const connections = (f.bank && f.bank.connections) || [];
    const accounts = (f.bank && f.bank.accounts) || [];
    const sources = f.sources || [];
    const liveBanks = connections.filter(c => c.status === 'active');
    const activeSources = sources.filter(s => s.is_active);
    const csv = activeSources.filter(s => s.ingest_mode === 'csv');
    const errored = accounts.filter(a => a.last_error_code);
    const metrics = [
      { label: 'Bank connections', value: count(liveBanks.length) },
      { label: 'Bank accounts syncing', value: count(accounts.length) },
      { label: 'Card sources', value: count(activeSources.length) },
      { label: 'Posting enabled', value: count(activeSources.filter(s => s.posting_enabled).length) },
    ];
    const limit = 'Silo can only see the accounts that were connected here. It has no way to know how many bank or card accounts the company holds in total, so this never means "all of them".';
    if (!liveBanks.length && !activeSources.length) {
      return { state: 'todo', summary: 'No bank or card feed reaches Silo yet', metrics, link,
        points: ['Nothing is feeding transactions into Silo. Connect a bank, or add a card source and upload a statement, before coding can begin.'], limit };
    }
    const points = [];
    if (liveBanks.length) {
      points.push(`${plural(liveBanks.length, 'bank connection')} syncing ${plural(accounts.length, 'account')}: ${liveBanks.map(c => c.institution_name || 'Unnamed institution').join(', ')}.`);
    } else {
      points.push('No bank is connected for automatic sync. Every transaction currently arrives by CSV upload.');
    }
    if (activeSources.length) {
      points.push(`${plural(activeSources.length, 'card source')} configured${csv.length ? `, ${count(csv.length)} of them fed by CSV upload` : ''}.`);
    }
    const stale = connections.filter(c => c.status !== 'active');
    if (stale.length) points.push(`${plural(stale.length, 'connection')} is not active and will not pull new transactions until it is reconnected.`);
    if (errored.length) points.push(`${plural(errored.length, 'account')} last reported a sync error (${errored.map(a => a.last_error_code).join(', ')}).`);
    if (errored.length || stale.length) {
      return { state: 'attention', summary: 'A connected feed has stopped', metrics, link, points, limit };
    }
    if (!liveBanks.length) {
      return { state: 'active', summary: `${plural(activeSources.length, 'card source')}, no live bank feed`, metrics, link, points, limit };
    }
    return { state: 'done', summary: `${plural(liveBanks.length, 'bank')} · ${plural(activeSources.length, 'source')}`, metrics, link, points, limit };
  }

  function openingStage(f) {
    const link = { surface: 'setup', text: 'Open Setup & opening balances' };
    if (isUnmeasured(f.opening) || isUnmeasured(f.settings)) {
      return { state: 'unknown', summary: 'Opening balances could not be read', link,
        points: ['Silo could not read the opening balance record on this load.'],
        limit: 'This is not evidence that no opening balance exists.' };
    }
    const limit = 'An accepted trial balance is a set of closing balances, not transaction detail. Open invoices, bills and reconciliation history are not part of it.';
    if (!f.opening) {
      return { state: 'todo', summary: 'No trial balance stored', link,
        points: ['Fetch a read-only trial balance from QuickBooks as of the day before Silo starts, then review it account by account.'], limit };
    }
    const start = f.settings && f.settings.accounting_start_date;
    const metrics = [
      { label: 'Balances as of', value: f.opening.as_of || '—' },
      { label: 'Silo starts', value: start || 'Not set' },
      { label: 'Accounts', value: count(f.opening.line_count) },
      { label: 'Basis', value: (f.settings && f.settings.accounting_basis) || '—' },
    ];
    if (f.opening.status !== 'accepted') {
      return { state: 'active', summary: 'Prepared, waiting on review', metrics, link,
        points: ['A trial balance is staged but nobody has accepted it. Acceptance freezes the baseline and needs a written review note; until then Silo has no starting balances.'], limit };
    }
    if (!start) {
      return { state: 'attention', summary: 'Accepted, but no start date is set', metrics, link,
        points: ['The opening balances are accepted but no accounting start date is recorded, so Silo cannot tell which transactions belong to it and which belong to QuickBooks history.'], limit };
    }
    return { state: 'done', summary: `Accepted · Silo starts ${start}`, metrics, link,
      points: [`Opening balances accepted${f.opening.accepted_at ? ` on ${String(f.opening.accepted_at).slice(0, 10)}` : ''}. Silo's own period begins ${start}; everything before that date is QuickBooks history.`], limit };
  }

  function historyStage(f) {
    const link = { surface: 'history', text: 'Open QBO history' };
    const limit = 'A balance match checks that QuickBooks’ own reports agree with each other. It does not prove every source document was retained: invoices, bills, payment applications and attachments are not archived by this step.';
    if (isUnmeasured(f.history) || isUnmeasured(f.settings)) {
      return { state: 'unknown', summary: 'Saved history could not be read', link,
        points: ['Silo could not read the saved history windows on this load.'], limit };
    }
    const rows = f.history || [];
    const cutover = f.settings && f.settings.accounting_start_date;
    if (!cutover) {
      return { state: 'unknown', summary: 'No start date to measure coverage against', link,
        points: [rows.length
          ? `${plural(rows.length, 'history window')} is saved, but without an accounting start date Silo cannot say whether that history runs up to the hand-off. Accept opening balances first.`
          : 'Coverage cannot be judged until an accounting start date is set.'], limit };
    }
    if (!rows.length) {
      return { state: 'todo', summary: 'No QuickBooks history retained', link,
        points: [`Nothing is archived yet. Save a general ledger and trial balance window ending ${addDays(cutover, -1)} so the detail behind your opening balances survives disconnecting QuickBooks.`], limit };
    }
    const cov = coverage(rows, cutover);
    const { kept, setAside } = independentSnapshots(rows);
    const exceptions = kept.reduce((n, r) => n + Number(r.exception_count || 0), 0);
    const lines = kept.reduce((n, r) => n + Number(r.transaction_count || 0), 0);
    const metrics = [
      { label: 'Retained from', value: cov.from || '—' },
      { label: 'Through', value: cov.to || '—' },
      { label: 'Snapshots saved', value: setAside ? `${count(rows.length)} (${count(kept.length)} counted)` : count(rows.length) },
      { label: 'Ledger lines', value: count(lines) },
    ];
    const points = [];
    points.push(cov.covered
      ? `History is retained from ${cov.from} through ${cov.to}, with no gaps, meeting the ${cutover} hand-off.`
      : `History is retained from ${cov.from} through ${cov.to}, but it does not run unbroken to ${cov.target}.`);
    if (cov.gaps.length) {
      points.push(`Missing: ${cov.gaps.map(g => `${g.from} → ${g.to}`).join(', ')}. Save those windows before disconnecting QuickBooks — that detail cannot be recovered afterwards.`);
    }
    points.push('How far back history should reach is your decision, not something Silo can read. The dates above are what is saved, not a target it was measured against.');
    if (setAside) {
      points.push(`${plural(setAside, 'saved snapshot')} covers a period another snapshot already covers. Each snapshot stands alone, so overlapping ones are never added together — the figures above come from ${plural(kept.length, 'snapshot')}.`);
    }
    if (exceptions) {
      points.push(`${plural(exceptions, 'account exception')} across the saved windows is still open. Review them in QBO history; an exception is an account the reports could not fully account for, not necessarily an error.`);
    }
    if (cov.gaps.length) return { state: 'attention', summary: 'A period is missing', metrics, link, points, limit };
    if (exceptions) return { state: 'attention', summary: `Covers ${cov.from} → ${cov.to} · ${plural(exceptions, 'exception')}`, metrics, link, points, limit };
    return { state: 'done', summary: `Covers ${cov.from} → ${cov.to}`, metrics, link, points, limit };
  }

  function codingStage(f) {
    const link = { href: 'transactions.html', text: 'Open Transactions' };
    const limit = 'This counts transactions that reached Silo. A charge no feed has delivered is not uncoded here — it is absent, and Silo cannot see it at all.';
    if (isUnmeasured(f.coding) || isUnmeasured(f.batches)) {
      return { state: 'unknown', summary: 'Coding progress could not be read', link,
        points: ['Silo could not read transaction coding on this load.'], limit };
    }
    const c = f.coding || { total: 0, uncoded: 0, rules: 0, splitRules: 0 };
    const batches = f.batches || [];
    const open = batches.filter(b => b.status === 'draft' || b.status === 'categorized');
    const metrics = [
      { label: 'Transactions', value: count(c.total) },
      { label: 'Waiting on a code', value: count(c.uncoded) },
      { label: 'Coding rules', value: count(c.rules) },
      { label: 'Split rules', value: count(c.splitRules) },
    ];
    if (!c.total) {
      return { state: 'todo', summary: 'No transactions in Silo yet', metrics, link,
        points: ['Nothing has been imported. Connect a feed or upload a statement, then code the rows and save the ones that repeat as rules.'], limit };
    }
    const coded = Math.max(0, c.total - c.uncoded);
    const points = [`${count(coded)} of ${count(c.total)} transactions carry an account. ${plural(c.rules, 'rule')} has been learned, so the next statement from the same cards arrives largely coded.`];
    /* A row coded across several accounts has no single account of its own by
       design, so "uncoded" is read from the coding source, never from a null
       account id -- reading the account would report every split as unfinished. */
    if (c.uncoded) points.push(`${plural(c.uncoded, 'transaction')} has no coding source at all: no rule matched, no suggestion was accepted and nobody has coded it by hand.`);
    if (open.length) points.push(`${plural(open.length, 'batch', 'batches')} is still open for editing and has not been approved.`);
    if (c.splitRules) points.push(`${plural(c.splitRules, 'split rule')} remembers which accounts a transaction divides across. It deliberately remembers no amounts — an amortizing payment splits differently every month.`);
    if (c.uncoded || open.length) {
      return { state: 'active', summary: `${count(coded)} of ${count(c.total)} coded`, metrics, link, points, limit };
    }
    return { state: 'done', summary: 'Nothing waiting to be coded', metrics, link, points, limit };
  }

  function revenueStage(f) {
    const link = { href: 'accounting-export.html', text: 'Open Accounting export' };
    const limit = 'Silo can see that entries were posted for a month. It cannot tell whether every revenue source is represented in them — an untouched store or an unbilled channel looks the same as a complete month from here.';
    if (isUnmeasured(f.journals) || isUnmeasured(f.batches) || isUnmeasured(f.settings) || isUnmeasured(f.revenue)) {
      return { state: 'unknown', summary: 'Posted entries could not be read', link,
        points: ['Silo could not read the journal register on this load.'], limit };
    }
    const cutover = f.settings && f.settings.accounting_start_date;
    const shops = (f.revenue && f.revenue.shops) || 0;
    const salesThrough = f.revenue && f.revenue.newestSalesDay;
    const metrics = [
      { label: 'Shopify stores', value: count(shops) },
      { label: 'Sales data through', value: salesThrough || 'None in Silo' },
      { label: 'Posted journals', value: count((f.journals || []).filter(j => j.status === 'posted').length) },
      { label: 'Posted batches', value: count((f.batches || []).filter(b => b.status === 'posted').length) },
    ];
    if (!cutover || !isDate(f.today)) {
      return { state: 'unknown', summary: 'No period to measure', metrics, link,
        points: ['Month-by-month coverage cannot be judged until an accounting start date and the company business date are both known.'], limit };
    }
    /* Only COMPLETE months are graded. The month in progress has no entries yet
       by definition, and counting it would report every company as behind. */
    const lastComplete = addDays(f.today.slice(0, 8) + '01', -1);
    const months = monthsFrom(cutover, lastComplete);
    const posted = new Set();
    (f.journals || []).filter(j => j.status === 'posted').forEach(j => posted.add(monthOf(j.entry_date)));
    (f.batches || []).filter(b => b.status === 'posted').forEach(b => posted.add(monthOf(b.entry_date)));
    const missing = months.filter(m => !posted.has(m));
    const points = [];
    points.push(shops
      ? `${plural(shops, 'Shopify store')} ${shops === 1 ? 'feeds' : 'feed'} sales into Silo${salesThrough ? `, with data through ${salesThrough}` : ', but no sales rows have landed yet'}.`
      : 'No Shopify store is connected, so revenue has to reach the ledger some other way.');
    if (!months.length) {
      return { state: 'todo', summary: 'No complete month since the hand-off yet', metrics, link,
        points: points.concat([`Silo's period began ${cutover}. No month has finished since, so there is nothing to close yet.`]), limit };
    }
    points.push(`${plural(months.length - missing.length, 'of ' + count(months.length) + ' month', 'of ' + count(months.length) + ' months')} since ${cutover} has a posted entry.`);
    if (missing.length) points.push(`Nothing posted for ${missing.join(', ')}. Build the sales journal and approve the card batches for those months.`);
    if (!posted.size) {
      return { state: 'todo', summary: `No entries posted since ${cutover}`, metrics, link, points, limit };
    }
    if (missing.length) {
      return { state: 'attention', summary: `${count(missing.length)} month${missing.length === 1 ? '' : 's'} with nothing posted`, metrics, link, points, limit };
    }
    return { state: 'done', summary: `Every month since ${cutover} is posted`, metrics, link, points, limit };
  }

  const BUILDERS = [
    { id: 'feeds', title: 'Banks and cards connected', build: feedsStage },
    { id: 'opening', title: 'Opening trial balance stored', build: openingStage },
    { id: 'history', title: 'QuickBooks history retained', build: historyStage },
    { id: 'coding', title: 'Coding and rules in Silo', build: codingStage },
    { id: 'revenue', title: 'Revenue journals posted', build: revenueStage },
  ];

  function assess(facts) {
    const f = facts || {};
    const stages = BUILDERS.map((b, index) => {
      const out = b.build(f) || {};
      return {
        id: b.id,
        index,
        title: b.title,
        state: out.state || 'unknown',
        stateLabel: STATES[out.state] || STATES.unknown,
        summary: out.summary || '',
        points: out.points || [],
        metrics: out.metrics || [],
        limit: out.limit || '',
        link: out.link || null,
      };
    });
    /* Position is the first step that is not finished -- including an unknown
       one. A step Silo could not measure is exactly where someone should look,
       so it must never be stepped over on the way to a later "done". */
    const open = stages.find(s => s.state !== 'done');
    const current = open || stages[stages.length - 1];
    const headline = open
      ? `Step ${current.index + 1} of ${stages.length} · ${current.title} — ${current.stateLabel.toLowerCase()}`
      : 'Every step Silo can measure is complete';
    return { stages, current, headline, complete: !open };
  }

  /* ---- rendering ---------------------------------------------------------- */

  function stepMarkup(stage, currentId) {
    const isCurrent = stage.id === currentId;
    return `<li class="migration-step migration-step--${esc(stage.state)}${isCurrent ? ' is-current' : ''}">`
      + `<button type="button" class="migration-step-btn" data-stage="${esc(stage.id)}"`
      + ` aria-expanded="false" aria-controls="migrationDetail"${isCurrent ? ' aria-current="step"' : ''}>`
      + `<span class="migration-step-top"><span class="migration-step-num" aria-hidden="true">${stage.index + 1}</span>`
      + `<span class="migration-step-state">${esc(stage.stateLabel)}</span></span>`
      + `<span class="migration-step-name">${esc(stage.title)}</span>`
      + `<span class="migration-step-summary">${esc(stage.summary)}</span></button></li>`;
  }

  function detailMarkup(stage) {
    const metrics = stage.metrics.length
      ? `<dl class="migration-metrics">${stage.metrics.map(m => `<div><dt>${esc(m.label)}</dt><dd>${esc(m.value)}</dd></div>`).join('')}</dl>`
      : '';
    const link = stage.link
      ? (stage.link.href
        ? `<a class="bcn-btn" href="${esc(stage.link.href)}">${esc(stage.link.text)} →</a>`
        : `<button type="button" class="bcn-btn" data-jump="${esc(stage.link.surface)}">${esc(stage.link.text)} →</button>`)
      : '';
    const prose = stage.points.map(p => `<p>${esc(p)}</p>`).join('')
      + `<p class="migration-limit"><span>What this does not say</span> ${esc(stage.limit)}</p>`;
    /* Where a step has FIGURES, they are the answer and the paragraphs are
       elaboration, so the paragraphs collapse. Where it has none -- an unknown
       step, or one nothing has started -- the prose IS the answer, and the only
       instruction for getting past it, so it stays open. Collapsing by habit
       would hide "Fetch a read-only trial balance from QuickBooks" behind a
       disclosure on the one screen whose entire job is to ask for it. */
    const body = stage.metrics.length
      ? `<details class="migration-more"><summary>What this means</summary>${prose}</details>`
      : prose;
    return `<h3>${esc(stage.title)} · ${esc(stage.stateLabel)}</h3>`
      + metrics
      + body
      + (link ? `<p class="migration-actions">${link}</p>` : '');
  }

  function render(root, model) {
    const section = root;
    section.querySelector('[data-migration-headline]').textContent = model.headline;
    section.querySelector('[data-migration-steps]').innerHTML =
      model.stages.map(s => stepMarkup(s, model.current.id)).join('');
    const detail = section.querySelector('#migrationDetail');
    const byId = Object.create(null);
    model.stages.forEach(s => { byId[s.id] = s; });

    function show(id) {
      const stage = byId[id];
      if (!stage) return;
      detail.innerHTML = detailMarkup(stage);
      detail.hidden = false;
      section.querySelectorAll('.migration-step-btn').forEach(b => {
        b.setAttribute('aria-expanded', String(b.dataset.stage === id));
        b.closest('.migration-step').classList.toggle('is-open', b.dataset.stage === id);
      });
    }

    section.querySelector('[data-migration-steps]').addEventListener('click', e => {
      const btn = e.target.closest('.migration-step-btn');
      if (btn) show(btn.dataset.stage);
    });
    detail.addEventListener('click', e => {
      const jump = e.target.closest('[data-jump]');
      if (!jump) return;
      /* Drive the page's own tabs by clicking them, rather than duplicating
         the show/hide logic here -- one definition of what a tab does. */
      const tab = document.querySelector(`.books-tabs [data-surface="${jump.dataset.jump}"]`);
      if (tab) { tab.click(); tab.scrollIntoView({ block: 'nearest' }); }
    });

    show(model.current.id);
    section.hidden = false;
    return { show };
  }

  /* ---- fact gathering -----------------------------------------------------
     Every read is settled independently. One table failing must degrade its
     own step to "Unknown", never blank the whole flow and never let a later
     step inherit a missing fact as an absent one. */
  async function mount(options) {
    const { db, companyId } = options || {};
    const root = (options && options.root) || el('migrationFlow');
    if (!root || !db || !companyId) return null;
    const scope = q => q.eq('company_entity_id', companyId);
    const rows = async q => { const r = await q; if (r.error) throw new Error(r.error.message); return r.data; };
    const one = async q => { const r = await q; if (r.error) throw new Error(r.error.message); return r.data; };
    const total = async q => { const r = await q; if (r.error) throw new Error(r.error.message); return r.count || 0; };

    const facts = {
      today: null, settings: UNMEASURED, opening: UNMEASURED, history: UNMEASURED,
      bank: UNMEASURED, sources: UNMEASURED, coding: UNMEASURED, batches: UNMEASURED,
      journals: UNMEASURED, revenue: UNMEASURED,
    };

    const jobs = [
      ['today', async () => {
        const d = await one(db.rpc('silo_business_today'));
        return isDate(String(d)) ? String(d) : null;
      }],
      ['settings', () => one(scope(db.from('accounting_settings')
        .select('accounting_start_date,accounting_basis,fiscal_year_start_month,qbo_connection_id')).maybeSingle())],
      ['opening', async () => {
        /* The snapshot holds every account line and is large; only its shape is
           needed here, so the line count comes from the accounts table instead
           of pulling the whole document across for a length. */
        const row = await one(scope(db.from('accounting_opening_balances')
          .select('id,status,accepted_at,created_at')).maybeSingle());
        if (!row) return null;
        const lines = await total(scope(db.from('accounting_accounts').select('id', { count: 'exact', head: true })));
        const settings = await one(scope(db.from('accounting_settings').select('accounting_start_date')).maybeSingle());
        return { status: row.status, accepted_at: row.accepted_at,
          as_of: settings && settings.accounting_start_date ? addDays(settings.accounting_start_date, -1) : null,
          line_count: lines };
      }],
      ['history', () => rows(scope(db.from('qbo_history_imports')
        .select('id,period_start,period_end,exception_count,transaction_count,reconciliation_status,created_at'))
        .order('period_start'))],
      ['bank', async () => ({
        connections: await rows(scope(db.from('plaid_connections').select('id,institution_name,status'))),
        accounts: await rows(scope(db.from('plaid_accounts').select('id,name,mask,type,last_synced_at,last_error_code'))),
      })],
      ['sources', () => rows(scope(db.from('card_sources')
        .select('id,source_key,display_name,source_type,ingest_mode,is_active,posting_enabled')))],
      ['coding', async () => ({
        total: await total(scope(db.from('card_transactions').select('id', { count: 'exact', head: true }))),
        uncoded: await total(scope(db.from('card_transactions').select('id', { count: 'exact', head: true })).is('coding_source', null)),
        rules: await total(scope(db.from('card_coding_rules').select('id', { count: 'exact', head: true })).eq('is_active', true)),
        splitRules: await total(scope(db.from('card_split_rules').select('id', { count: 'exact', head: true }))),
      })],
      ['batches', () => rows(scope(db.from('card_import_batches')
        .select('id,status,entry_date,period_start,period_end,row_count')).order('entry_date'))],
      ['journals', () => rows(scope(db.from('journal_adjustments')
        .select('id,status,entry_date,memo,source_context')).order('entry_date'))],
      ['revenue', async () => {
        const shops = await rows(scope(db.from('shopify_connections').select('id,shop_domain,is_active')));
        const newest = await rows(scope(db.from('sales_by_day').select('day_date'))
          .order('day_date', { ascending: false }).limit(1));
        return {
          shops: shops.filter(s => s.is_active !== false).length,
          newestSalesDay: newest && newest.length ? newest[0].day_date : null,
        };
      }],
    ];

    const settled = await Promise.all(jobs.map(async ([key, run]) => {
      try { return [key, await run()]; } catch (err) { return [key, key === 'today' ? null : UNMEASURED]; }
    }));
    settled.forEach(([key, value]) => { facts[key] = value; });

    const model = assess(facts);
    const api = render(root, model);
    return { facts, model, show: api.show };
  }

  window.SiloMigrationStatus = {
    UNMEASURED, isUnmeasured, STATES, assess, mount, detailMarkup,
    mergeWindows, coverage, monthsFrom, addDays, independentSnapshots,
  };
})();
