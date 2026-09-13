/* Cash movement model. Provider amounts are positive out / negative in.
   Accounting approval/status never gates a posted bank movement. */
(function () {
  "use strict";
  const DAY = 86400000;
  const date = (s) => new Date(s + "T00:00:00Z");
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => {
    const d = date(s);
    d.setUTCDate(d.getUTCDate() + n);
    return iso(d);
  };
  const days = (a, b) => Math.round((date(b) - date(a)) / DAY) + 1;
  const validDate = (s) =>
    /^\d{4}-\d{2}-\d{2}$/.test(s || "") &&
    !isNaN(date(s)) &&
    iso(date(s)) === s;
  function addMonths(s, n) {
    const d = date(s),
      day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    const end = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
    ).getUTCDate();
    d.setUTCDate(Math.min(day, end));
    return iso(d);
  }
  const cents = (v) =>
    v == null || v === "" || !Number.isFinite(Number(v))
      ? null
      : Math.round(Number(v) * 100);
  function columns(start, end, unit, kind) {
    const out = [];
    let cursor = start;
    while (cursor <= end) {
      const d = date(cursor);
      let next;
      if (unit === "day") next = cursor;
      else if (unit === "week") next = addDays(cursor, (7 - d.getUTCDay()) % 7);
      else
        next = iso(
          new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)),
        );
      const stop = next < end ? next : end;
      out.push({ start: cursor, end: stop, kind, days: days(cursor, stop) });
      cursor = addDays(stop, 1);
    }
    return out;
  }
  function occurrences(item, start, end) {
    if (!validDate(item.start_date) || !validDate(start) || !validDate(end))
      return [];
    const limit = item.end_date && item.end_date < end ? item.end_date : end;
    if (item.kind === "one_time")
      return item.start_date >= start && item.start_date <= limit
        ? [item.start_date]
        : [];
    const step = { monthly: 1, quarterly: 3, annual: 12 }[item.cadence];
    const dayStep = { weekly: 7, biweekly: 14 }[item.cadence];
    if (!step && !dayStep) return [];
    let n = dayStep
      ? Math.max(
          0,
          Math.floor((date(start) - date(item.start_date)) / DAY / dayStep) - 1,
        )
      : Math.max(
          0,
          Math.floor(
            ((date(start).getUTCFullYear() -
              date(item.start_date).getUTCFullYear()) *
              12 +
              date(start).getUTCMonth() -
              date(item.start_date).getUTCMonth()) /
              step,
          ) - 1,
        );
    const out = [];
    for (let count = 0; count < 1000; count++, n++) {
      const d = step
        ? addMonths(item.start_date, n * step)
        : addDays(item.start_date, n * dayStep);
      if (d > limit) break;
      if (d >= start) out.push(d);
    }
    return out;
  }
  const median = (values) => {
    const v = [...values].sort((a, b) => a - b),
      i = Math.floor(v.length / 2);
    return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
  };
  function merchantKey(t) {
    const name = String(t.clean_merchant || t.description || "")
      .toLowerCase()
      .replace(/\b\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?\b/g, " ")
      .replace(/\b[a-z0-9]*\d[a-z0-9]{5,}\b/g, " ")
      .replace(/[^a-z ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return /^(payment|deposit|withdrawal|transfer|purchase|unknown)?$/.test(
      name,
    )
      ? ""
      : name;
  }
  function detectTiming(observations, today) {
    // Three monthly cycles or four weekly/fortnightly cycles, with no missing
    // cycle, are required. Amounts are estimated from the median observed bill.
    const sorted = [...observations].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    if (
      sorted.length < 3 ||
      new Set(sorted.map((o) => o.date)).size !== sorted.length
    )
      return null;
    const gaps = sorted
        .slice(1)
        .map((o, i) => days(sorted[i].date, o.date) - 1),
      last = sorted.at(-1).date;
    const monthIndex = (d) =>
      Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
    const dom = sorted.map((o) => Number(o.date.slice(8)));
    const monthEnd = sorted.every(
      (o) =>
        days(
          o.date,
          iso(
            new Date(
              Date.UTC(
                date(o.date).getUTCFullYear(),
                date(o.date).getUTCMonth() + 1,
                0,
              ),
            ),
          ),
        ) <= 3,
    );
    let cadence, anchor;
    if (
      gaps.every((g) => g >= 26 && g <= 35) &&
      sorted
        .slice(1)
        .every(
          (o, i) => monthIndex(o.date) - monthIndex(sorted[i].date) === 1,
        ) &&
      (monthEnd || Math.max(...dom) - Math.min(...dom) <= 3)
    ) {
      cadence = "monthly";
      const next = addMonths(last.slice(0, 8) + "01", 1),
        day = monthEnd ? 31 : Math.round(median(dom));
      const end = Number(
        iso(
          new Date(
            Date.UTC(
              date(next).getUTCFullYear(),
              date(next).getUTCMonth() + 1,
              0,
            ),
          ),
        ).slice(8),
      );
      anchor = next.slice(0, 8) + String(Math.min(day, end)).padStart(2, "0");
      if (days(last, today) - 1 > 35) return null;
    } else if (sorted.length >= 4 && gaps.every((g) => g >= 6 && g <= 8)) {
      cadence = "weekly";
      anchor = addDays(last, 7);
      if (days(last, today) - 1 > 10) return null;
    } else if (sorted.length >= 4 && gaps.every((g) => g >= 13 && g <= 15)) {
      cadence = "biweekly";
      anchor = addDays(last, 14);
      if (days(last, today) - 1 > 17) return null;
    } else return null;
    const amounts = sorted.map((o) => Math.abs(o.movement)),
      amount = Math.round(median(amounts));
    if (
      !amount ||
      Math.max(...amounts) > amount * 3 ||
      Math.min(...amounts) < amount * 0.2
    )
      return null;
    return {
      cadence,
      anchor,
      monthEnd,
      day: Math.round(median(dom)),
      amount,
      samples: sorted.length,
      last,
    };
  }
  function timedDates(pattern, start, end) {
    if (pattern.cadence !== "monthly")
      return occurrences(
        {
          kind: "recurring",
          cadence: pattern.cadence,
          start_date: pattern.anchor,
        },
        start,
        end,
      );
    const out = [];
    let month = addMonths(pattern.last.slice(0, 8) + "01", 1);
    while (month <= end) {
      const monthLast = iso(
        new Date(
          Date.UTC(
            date(month).getUTCFullYear(),
            date(month).getUTCMonth() + 1,
            0,
          ),
        ),
      );
      const d = pattern.monthEnd
        ? monthLast
        : month.slice(0, 8) +
          String(Math.min(pattern.day, Number(monthLast.slice(8)))).padStart(
            2,
            "0",
          );
      if (d >= start && d <= end) out.push(d);
      month = addMonths(month, 1);
    }
    return out;
  }
  function flowFor(type, treatment) {
    if (treatment === "transfer" || type === "Bank") return "Transfers";
    if (treatment === "card_payment" || type === "Credit Card")
      return "Card paydowns";
    if (["Fixed Asset", "Other Asset"].includes(type)) return "Investing";
    if (["Long Term Liability", "Equity"].includes(type)) return "Financing";
    return "Operating";
  }
  const coaKey = (connection, id) =>
    "coa|" +
    encodeURIComponent(connection || "") +
    "|" +
    encodeURIComponent(id);
  function catalog(accounts) {
    return new Map(
      accounts.map((a) => [
        coaKey(a.connection_id, a.qbo_account_id),
        {
          key: coaKey(a.connection_id, a.qbo_account_id),
          name: a.fully_qualified_name || a.name,
          type: a.account_type,
          flow: flowFor(a.account_type),
        },
      ]),
    );
  }
  function build({
    today,
    lookback = 90,
    horizon = 3,
    unit = "week",
    group = "coa",
    currency = "USD",
    selected = "all",
    accounts = [],
    sources = [],
    transactions = [],
    chart = [],
    plans = [],
    overrides = [],
    baseCurrency = "USD",
    trend = true,
    timing = true,
    projections = [],
    projectionEnabled = false,
    collectionPercent = 100,
    collectionLag = 0,
    whatIf = [],
  }) {
    if (
      !validDate(today) ||
      ![30, 90].includes(lookback) ||
      ![3, 6].includes(horizon) ||
      !["day", "week", "month"].includes(unit) ||
      !["coa", "cashflow"].includes(group)
    )
      throw new Error("Invalid cashflow date settings.");
    const historyStart = addDays(today, 1 - lookback),
      futureStart = addDays(today, 1),
      futureEnd = addMonths(today, horizon);
    const cols = [
      ...columns(historyStart, today, unit, "actual"),
      ...columns(futureStart, futureEnd, unit, "forecast"),
    ];
    const connected = accounts.filter(
      (a) =>
        a.iso_currency_code === currency &&
        a.connection_status !== "disconnected",
    );
    const allCash = connected.filter((a) => a.type === "depository"),
      cash = allCash.filter((a) => selected === "all" || a.id === selected);
    const accountMap = new Map(connected.map((a) => [a.id, a])),
      cashIds = new Set(allCash.map((a) => a.id)),
      selectedIds = new Set(cash.map((a) => a.id));
    const sourceMap = new Map(sources.map((s) => [s.id, s])),
      coa = catalog(chart);
    function resolve(key, label) {
      return (
        coa.get(key) ||
        (key === "uncategorized"
          ? { key, name: "Uncategorized", flow: "Uncategorized" }
          : key === "excluded"
            ? { key, name: "Excluded from coding", flow: "Uncategorized" }
            : key?.startsWith("flow|")
              ? { key, name: key.slice(5), flow: key.slice(5) }
              : {
                  key: key || "plan|" + label,
                  name: label || key || "Planning",
                  flow: "Planning",
                })
      );
    }
    function bucket(t) {
      if (t.status === "excluded") return resolve("excluded");
      if (!t.qbo_account_id) return resolve("uncategorized");
      const connection = sourceMap.get(
        accountMap.get(t.plaid_account_id)?.source_id,
      )?.qbo_connection_id;
      const c = resolve(
        coaKey(connection, t.qbo_account_id),
        t.qbo_account_name || "Category unavailable",
      );
      return { ...c, flow: flowFor(c.type, t.accounting_treatment) };
    }
    // Keep dated, account-attributed events until the last step. Aggregation cannot
    // change the forecast, hide a daily low, or change a saved override's dates.
    const actualEvents = [],
      series = new Map(),
      coverage = new Map(),
      seen = new Set();
    let pending = 0,
      uncategorized = 0,
      excluded = 0,
      postedCount = 0;
    for (const t of transactions) {
      if (
        t.origin !== "plaid" ||
        !cashIds.has(t.plaid_account_id) ||
        t.currency !== currency ||
        !validDate(t.txn_date) ||
        t.txn_date < historyStart ||
        t.txn_date > today
      )
        continue;
      if (t.provider_status === "pending") {
        if (selectedIds.has(t.plaid_account_id)) pending++;
        continue;
      }
      if (t.provider_status !== "posted") continue;
      const identity =
        t.plaid_account_id + "|" + (t.external_transaction_id || t.id);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const amount = cents(t.amount);
      if (amount === null)
        throw new Error("A bank transaction has an invalid amount.");
      const movement = -amount,
        category = bucket(t),
        direction = movement >= 0 ? "in" : "out";
      actualEvents.push({
        date: t.txn_date,
        account: t.plaid_account_id,
        movement,
        category,
        direction,
        source: "actual",
        transaction: { ...t, movement, category: category.name },
      });
      if (selectedIds.has(t.plaid_account_id)) {
        postedCount++;
        if (!t.qbo_account_id) uncategorized++;
        if (t.status === "excluded") excluded++;
      }
      if (t.txn_date === today) continue;
      if (
        !coverage.has(t.plaid_account_id) ||
        t.txn_date < coverage.get(t.plaid_account_id)
      )
        coverage.set(t.plaid_account_id, t.txn_date);
      if (
        category.flow === "Transfers" ||
        t.accounting_treatment === "transfer"
      )
        continue;
      const merchant = merchantKey(t);
      const key =
        t.plaid_account_id +
        "|" +
        direction +
        "|" +
        category.key +
        "|" +
        merchant;
      if (!series.has(key))
        series.set(key, {
          account: t.plaid_account_id,
          direction,
          category,
          total: 0,
          merchant,
          observations: [],
        });
      series.get(key).total += movement;
      series.get(key).observations.push({ date: t.txn_date, movement });
    }
    const companyPlans = selected === "all" && currency === baseCurrency;
    const planItems =
      currency === baseCurrency
        ? plans.filter((p) => p.is_active !== false)
        : [];
    const applicableOverrides =
      currency === baseCurrency
        ? overrides.filter(
            (o) =>
              o.is_active !== false &&
              o.currency === currency &&
              o.end_date >= futureStart &&
              o.start_date <= futureEnd,
          )
        : [];
    const invalidAssignments = [];
    const assignmentValid = (p) => {
      if (
        (p.account_id && !cashIds.has(p.account_id)) ||
        (p.counter_account_id &&
          (!p.account_id ||
            p.counter_account_id === p.account_id ||
            !accountMap.has(p.counter_account_id)))
      ) {
        invalidAssignments.push(p.id);
        return false;
      }
      return true;
    };
    const resolvedPlans = planItems
      .map((p) => ({
        ...p,
        categoryInfo: resolve(
          p.category,
          p.category?.startsWith("coa|")
            ? "Saved COA bucket"
            : p.category || p.label,
        ),
        movement: cents(p.amount),
      }))
      .filter(assignmentValid);
    const validOverrides = applicableOverrides.filter(assignmentValid);
    let events = [];
    function appendMovement(target, p, date, movement, category, source) {
      const direction =
          source === "override" ? p.direction : movement >= 0 ? "in" : "out",
        counter = accountMap.get(p.counter_account_id);
      target.push({
        date,
        account: p.account_id || null,
        movement,
        category,
        direction,
        source,
        id: p.id,
        paired: !!counter,
      });
      if (counter) {
        // Assets rise when cash leaves; liabilities owed fall when cash leaves.
        const liability = ["credit", "loan"].includes(counter.type);
        target.push({
          date,
          account: counter.id,
          movement: liability ? movement : -movement,
          category: {
            key: "flow|Transfers",
            name: "Transfers between accounts",
            flow: "Transfers",
          },
          direction: movement >= 0 ? "out" : "in",
          source,
          id: p.id,
          paired: true,
          nonCash: counter.type !== "depository",
        });
      }
    }
    const trendDays = days(futureStart, futureEnd),
      patterns = [],
      bankEvents = [];
    for (const s of series.values()) {
      const pattern =
        timing && s.merchant ? detectTiming(s.observations, today) : null;
      const scheduled = pattern
        ? new Set(timedDates(pattern, futureStart, futureEnd))
        : null;
      if (pattern && selectedIds.has(s.account))
        patterns.push({
          ...pattern,
          merchant: s.merchant,
          category: s.category.name,
          account: s.account,
          direction: s.direction,
          nextDate: [...scheduled][0] || null,
        });
      const denominator = days(coverage.get(s.account), addDays(today, -1));
      let previous = 0;
      for (let n = 1; n <= trendDays; n++) {
        const d = addDays(futureStart, n - 1),
          cumulative = Math.round((s.total * n) / denominator);
        const amount = pattern
          ? scheduled.has(d)
            ? (s.direction === "out" ? -1 : 1) * pattern.amount
            : 0
          : cumulative - previous;
        previous = cumulative;
        const replaced = resolvedPlans.some(
          (p) =>
            p.kind === "recurring" &&
            (p.movement >= 0 ? "in" : "out") === s.direction &&
            (p.category === s.category.key ||
              p.category === "flow|" + s.category.flow) &&
            p.start_date <= d &&
            (!p.end_date || p.end_date >= d) &&
            (!p.account_id || p.account_id === s.account),
        );
        if (trend && amount) {
          const event = {
            date: d,
            account: s.account,
            movement: amount,
            category: s.category,
            direction: s.direction,
            source: "trend",
          };
          bankEvents.push(event);
          if (!replaced) events.push(event);
        }
      }
    }
    const projectionInfo = {
      count: 0,
      total: 0,
      enabled:
        projectionEnabled && currency === baseCurrency && selected === "all",
    };
    if (projectionInfo.enabled) {
      if (
        !Number.isFinite(collectionPercent) ||
        collectionPercent < 0 ||
        collectionPercent > 100 ||
        !Number.isInteger(collectionLag) ||
        collectionLag < 0 ||
        collectionLag > 60
      )
        throw new Error("Invalid projection collection assumptions.");
      const seenProjections = new Set();
      for (const p of projections) {
        if (
          p.scenario !== "active" ||
          !validDate(p.projection_date) ||
          p.projection_date <= today
        )
          continue;
        const identity = p.id || p.location_id + "|" + p.projection_date;
        if (seenProjections.has(identity)) continue;
        seenProjections.add(identity);
        const receiptDate = addDays(p.projection_date, collectionLag);
        if (receiptDate < futureStart || receiptDate > futureEnd) continue;
        const sales = cents(p.projected_sales);
        if (sales === null || sales < 0)
          throw new Error("A revenue projection has an invalid amount.");
        const amount = Math.round((sales * collectionPercent) / 100);
        projectionInfo.count++;
        projectionInfo.total += amount;
        appendMovement(
          events,
          { id: "projection|" + identity },
          receiptDate,
          amount,
          {
            key: "flow|Revenue projections",
            name: "Revenue projections",
            flow: "Revenue projections",
          },
          "projection",
        );
      }
    }
    for (const p of resolvedPlans) {
      if (p.movement === null || !p.movement)
        throw new Error("A planning item has an invalid amount.");
      for (const d of occurrences(p, futureStart, futureEnd))
        appendMovement(events, p, d, p.movement, p.categoryInfo, "planned");
    }
    const baselineEvents = events.slice();
    const matches = (e, o) =>
      !e.nonCash &&
      e.direction === o.direction &&
      (o.scope_group === "cashflow"
        ? e.category.flow === o.category_key
        : e.category.key === o.category_key);
    const overrideDetails = [];
    // Leaf overrides first; a broad cashflow-group override is the final total.
    for (const o of [...validOverrides].sort(
      (a, b) =>
        (a.scope_group === "cashflow") - (b.scope_group === "cashflow") ||
        a.start_date.localeCompare(b.start_date),
    )) {
      const amount = cents(o.amount);
      if (
        amount === null ||
        amount < 0 ||
        !validDate(o.payment_date) ||
        o.payment_date < o.start_date ||
        o.payment_date > o.end_date
      )
        throw new Error("A forecast override is invalid.");
      const removed = events.filter(
        (e) => e.date >= o.start_date && e.date <= o.end_date && matches(e, o),
      );
      // Remove both legs of a replaced account movement, including its liability leg.
      const pairs = new Set(
        removed
          .filter((e) => e.paired)
          .map((e) => e.source + "|" + e.id + "|" + e.date),
      );
      events = events.filter(
        (e) =>
          !(e.date >= o.start_date && e.date <= o.end_date && matches(e, o)) &&
          !(e.paired && pairs.has(e.source + "|" + e.id + "|" + e.date)),
      );
      const category =
        o.scope_group === "cashflow"
          ? {
              key: "flow|" + o.category_key,
              name: o.category_label + " · override",
              flow: o.category_key,
            }
          : { key: o.category_key, name: o.category_label, flow: o.flow_key };
      overrideDetails.push({
        ...o,
        baseline: removed.reduce((n, e) => n + e.movement, 0),
        category,
      });
      if (o.payment_date >= futureStart && o.payment_date <= futureEnd)
        appendMovement(
          events,
          o,
          o.payment_date,
          (o.direction === "out" ? -1 : 1) * amount,
          category,
          "override",
        );
    }
    const savedEvents = events.slice();
    let whatIfTotal = 0,
      whatIfCount = 0;
    for (const w of whatIf) {
      if (
        selected !== "all" ||
        w.currency !== currency ||
        !validDate(w.date) ||
        w.date < futureStart ||
        w.date > futureEnd
      )
        continue;
      const amount = cents(w.amount);
      if (amount === null || !amount)
        throw new Error("A what-if amount is invalid.");
      appendMovement(
        events,
        { id: w.id },
        w.date,
        amount,
        {
          key: "whatif|" + w.id,
          name: "What if · " + w.label,
          flow: "What if",
        },
        "whatif",
      );
      whatIfTotal += amount;
      whatIfCount++;
    }
    const visible = (e) =>
      !e.nonCash && (selected === "all" || e.account === selected);
    const rows = new Map(),
      colIndex = new Map();
    cols.forEach((c, i) => {
      for (let d = c.start; d <= c.end; d = addDays(d, 1)) colIndex.set(d, i);
    });
    function row(direction, category) {
      const key =
        direction + "|" + (group === "cashflow" ? category.flow : category.key);
      if (!rows.has(key))
        rows.set(key, {
          key,
          direction,
          categoryKey: category.key,
          flow: category.flow,
          label: group === "cashflow" ? category.flow : category.name,
          actual: Array(cols.length).fill(0),
          forecast: Array(cols.length).fill(0),
          planned: Array(cols.length).fill(0),
          trend: Array(cols.length).fill(0),
          manual: Array(cols.length).fill(0),
          projection: Array(cols.length).fill(0),
          whatif: Array(cols.length).fill(0),
          overrides: Array.from({ length: cols.length }, () => []),
          transactions: Array.from({ length: cols.length }, () => []),
        });
      return rows.get(key);
    }
    for (const e of [...actualEvents, ...events].filter(visible)) {
      const r = row(e.direction, e.category),
        i = colIndex.get(e.date);
      if (i === undefined) continue;
      if (e.source === "actual") {
        r.actual[i] += e.movement;
        r.transactions[i].push(e.transaction);
      } else {
        r.forecast[i] += e.movement;
        r[e.source === "override" ? "manual" : e.source][i] += e.movement;
      }
    }
    // Preserve a zero override as an editable cell even when it removes all events.
    for (const o of overrideDetails) {
      if (selected !== "all" && o.account_id !== selected) continue;
      const r = row(o.direction, o.category);
      cols.forEach((c, i) => {
        if (
          c.kind === "forecast" &&
          c.start <= o.end_date &&
          c.end >= o.start_date
        )
          r.overrides[i].push(o.id);
      });
    }
    const values = [...rows.values()];
    const inflow = cols.map((c, i) =>
      values
        .filter((r) => r.direction === "in")
        .reduce(
          (n, r) => n + (c.kind === "actual" ? r.actual[i] : r.forecast[i]),
          0,
        ),
    );
    const outflow = cols.map((c, i) =>
      values
        .filter((r) => r.direction === "out")
        .reduce(
          (n, r) => n + (c.kind === "actual" ? r.actual[i] : r.forecast[i]),
          0,
        ),
    );
    const net = cols.map((c, i) => inflow[i] + outflow[i]);
    const balances = cash.map((a) => cents(a.current_balance));
    const currentCash =
      cash.length && balances.every((n) => n !== null)
        ? balances.reduce((a, b) => a + b, 0)
        : null;
    function trajectory(list) {
      const totals = new Map();
      for (const e of list.filter(visible))
        totals.set(e.date, (totals.get(e.date) || 0) + e.movement);
      let balance = currentCash,
        low = currentCash,
        lowDate = today;
      const daily = [{ date: today, balance }];
      for (let d = futureStart; d <= futureEnd; d = addDays(d, 1)) {
        balance = balance === null ? null : balance + (totals.get(d) || 0);
        daily.push({ date: d, balance });
        if (balance !== null && balance < low) {
          low = balance;
          lowDate = d;
        }
      }
      const byDate = new Map(daily.map((d) => [d.date, d.balance]));
      return {
        daily,
        low,
        lowDate,
        ending: cols.map((c) =>
          c.kind === "forecast" ? byDate.get(c.end) : null,
        ),
      };
    }
    const path = trajectory(events),
      baseline = trajectory(baselineEvents);
    const byAccount = new Map(
      connected.map((a) => [
        a.id,
        {
          actual: Array(cols.length).fill(0),
          forecast: Array(cols.length).fill(0),
        },
      ]),
    );
    const unallocatedChanges = Array(cols.length).fill(0);
    for (const e of [...actualEvents, ...events]) {
      const i = colIndex.get(e.date);
      if (i === undefined) continue;
      if (e.account) {
        const a = byAccount.get(e.account);
        if (a)
          a[e.source === "actual" ? "actual" : "forecast"][i] += e.movement;
      } else if (visible(e)) unallocatedChanges[i] += e.movement;
    }
    const liquidity = connected
      .filter((a) => selected === "all" || a.id === selected)
      .map((a) => {
        const current = cents(a.current_balance),
          isCash = a.type === "depository",
          changes = byAccount.get(a.id);
        let running = current,
          later = 0;
        const reconstructed = Array(cols.length).fill(null);
        for (let i = cols.length - 1; i >= 0; i--)
          if (cols[i].kind === "actual") {
            reconstructed[i] =
              isCash && current !== null ? current - later : null;
            later += changes.actual[i];
          }
        const ending = cols.map((c, i) => {
          if (c.kind === "actual") return reconstructed[i];
          running = running === null ? null : running + changes.forecast[i];
          return running;
        });
        return { id: a.id, label: a.name, type: a.type, current, ending };
      });
    let unallocated = 0;
    const unallocatedEnding = cols.map((c, i) => {
      if (c.kind === "actual") return null;
      unallocated += unallocatedChanges[i];
      return unallocated;
    });
    const liquidityTotal = cols.map((c, i) => {
      if (c.kind === "forecast") return path.ending[i];
      const balances = liquidity
        .filter((a) => a.type === "depository")
        .map((a) => a.ending[i]);
      return balances.length && balances.every((n) => n !== null)
        ? balances.reduce((a, b) => a + b, 0)
        : null;
    });
    return {
      cols,
      rows: values.sort(
        (a, b) =>
          a.direction.localeCompare(b.direction) ||
          a.label.localeCompare(b.label),
      ),
      cash,
      currentCash,
      inflow,
      outflow,
      net,
      ...path,
      baselineEnding: baseline.ending,
      baselineDaily: baseline.daily,
      bankDaily: trajectory(bankEvents).daily,
      savedDaily: trajectory(savedEvents).daily,
      patterns,
      projectionInfo,
      whatIfTotal,
      whatIfCount,
      liquidity,
      liquidityTotal,
      unallocatedEnding,
      overrideDetails,
      invalidAssignments,
      coverage: [...coverage]
        .filter(([id]) => selectedIds.has(id))
        .map(([id, start]) => ({
          id,
          start,
          days: days(start, addDays(today, -1)),
        })),
      pending,
      uncategorized,
      excluded,
      postedCount,
      companyPlans,
      historyStart,
      futureStart,
      futureEnd,
    };
  }
  window.SiloCashflow = {
    build,
    columns,
    occurrences,
    addDays,
    addMonths,
    validDate,
    cents,
    coaKey,
    catalog,
    flowFor,
    detectTiming,
    timedDates,
  };
})();
