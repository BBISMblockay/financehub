(function () {
  "use strict";
  const M = window.SiloCashflow,
    cfg = window.__SILO_CONFIG__ || {},
    el = (id) => document.getElementById(id);
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  let db,
    company,
    today,
    data,
    model,
    userId,
    editing = null,
    overrideEditing = null,
    busy = false,
    ready = false;
  let whatIf = [],
    whatIfSequence = 0;
  let filters = {
    currency: "USD",
    selected: "all",
    unit: "week",
    group: "coa",
    horizon: 3,
    lookback: 90,
    trend: true,
    timing: true,
    projectionEnabled: false,
    collectionPercent: 100,
    collectionLag: 0,
  };
  const result = async (q) => {
    const r = await q;
    if (r.error) throw r.error;
    return r.data;
  };
  async function pages(table, fields, refine = (q) => q) {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const part = await result(
        refine(
          db.from(table).select(fields).eq("company_entity_id", company.id),
        )
          .order("id")
          .range(offset, offset + 499),
      );
      rows.push(...part);
      if (part.length < 500) return rows;
    }
  }
  const money = (n) =>
    n === null
      ? "—"
      : new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: filters.currency,
          maximumFractionDigits: 2,
        }).format(n / 100);
  const short = (d) =>
    new Date(d + "T00:00:00Z").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const status = (s) => {
    el("status").textContent = s;
  };
  function persist() {
    try {
      localStorage.setItem(
        "silo-cashflow:" + company.id,
        JSON.stringify(filters),
      );
    } catch {}
  }
  function restore() {
    try {
      const f = JSON.parse(
        localStorage.getItem("silo-cashflow:" + company.id) || "{}",
      );
      for (const [key, allowed] of Object.entries({
        unit: ["day", "week", "month"],
        group: ["coa", "cashflow"],
        horizon: [3, 6],
        lookback: [30, 90],
        trend: [true, false],
        timing: [true, false],
        projectionEnabled: [true, false],
      }))
        if (allowed.includes(f[key])) filters[key] = f[key];
      if (
        Number.isFinite(f.collectionPercent) &&
        f.collectionPercent >= 0 &&
        f.collectionPercent <= 100
      )
        filters.collectionPercent = f.collectionPercent;
      if (
        Number.isInteger(f.collectionLag) &&
        f.collectionLag >= 0 &&
        f.collectionLag <= 60
      )
        filters.collectionLag = f.collectionLag;
      if (/^[A-Z]{3}$/.test(f.currency)) filters.currency = f.currency;
      if (typeof f.selected === "string") filters.selected = f.selected;
    } catch {}
  }
  async function load() {
    if (busy || el("planDialog").open || el("overrideDialog").open) return;
    busy = true;
    ready = false;
    el("refresh").disabled = true;
    el("add").disabled = true;
    el("overrideAdd").disabled = true;
    status("Loading saved Plaid balances and transactions…");
    el("matrix").setAttribute("aria-busy", "true");
    // Clear previous conclusions immediately: failed reloads must not look like fresh forecasts.
    el("summary").innerHTML = "";
    el("matrix").innerHTML = "";
    el("liquidity").innerHTML = "";
    el("charts").innerHTML = "";
    el("flowTotals").innerHTML = "";
    el("patterns").innerHTML = "";
    el("projectionStatus").textContent = "Loading planning inputs…";
    try {
      const active = await cfg.ensureActiveCompany(db);
      if (active?.id !== company.id)
        throw new Error("Company changed. Reload this page.");
      today = await result(db.rpc("silo_business_today"));
      if (!M.validDate(today)) throw new Error("Company date is unavailable");
      const [
        accounts,
        connections,
        sources,
        chart,
        plans,
        overrides,
        settings,
        revenue,
      ] = await Promise.all([
        pages(
          "plaid_accounts",
          "id,connection_id,name,mask,type,subtype,iso_currency_code,current_balance,balance_updated_at,last_synced_at,source_id",
        ),
        pages("plaid_connections", "id,institution_name,status"),
        pages("card_sources", "id,qbo_connection_id"),
        pages(
          "quickbooks_accounts",
          "id,qbo_account_id,name,fully_qualified_name,account_type,connection_id",
        ),
        pages(
          "cash_forecast_items",
          "id,label,category,amount,kind,cadence,start_date,end_date,is_active,updated_at,account_id,counter_account_id",
          (q) => q.eq("is_active", true),
        ),
        pages(
          "cash_forecast_overrides",
          "id,currency,scope_group,category_key,category_label,flow_key,direction,start_date,end_date,payment_date,amount,account_id,counter_account_id,is_active,updated_at",
          (q) => q.eq("is_active", true),
        ),
        result(
          db
            .from("accounting_settings")
            .select("base_currency")
            .eq("company_entity_id", company.id)
            .maybeSingle(),
        ),
        pages(
          "revenue_projections",
          "id,projection_date,location_id,projected_sales,scenario",
          (q) =>
            q
              .eq("scenario", "active")
              .gte("projection_date", M.addDays(today, 1))
              .lte("projection_date", M.addMonths(today, 6)),
        ).then(
          (rows) => ({ rows, error: null }),
          (e) => ({ rows: [], error: e.message }),
        ),
      ]);
      const conn = new Map(connections.map((c) => [c.id, c]));
      accounts.forEach((a) => {
        a.connection_status =
          conn.get(a.connection_id)?.status || "disconnected";
        a.institution = conn.get(a.connection_id)?.institution_name || "";
      });
      const ids = accounts
          .filter(
            (a) =>
              a.type === "depository" && a.connection_status !== "disconnected",
          )
          .map((a) => a.id),
        transactions = [];
      for (let i = 0; i < ids.length; i += 100)
        transactions.push(
          ...(await pages(
            "card_transactions",
            "id,plaid_account_id,external_transaction_id,batch_id,txn_date,description,clean_merchant,amount,currency,origin,provider_status,status,qbo_account_id,qbo_account_name,accounting_treatment",
            (q) =>
              q
                .eq("origin", "plaid")
                .in("plaid_account_id", ids.slice(i, i + 100))
                .gte("txn_date", M.addDays(today, -89))
                .lte("txn_date", today),
          )),
        );
      data = {
        accounts,
        sources,
        chart,
        plans,
        overrides,
        transactions,
        baseCurrency: settings?.base_currency || "USD",
        projections: revenue.rows,
        projectionError: revenue.error,
      };
      const currencies = [
        ...new Set(
          accounts
            .filter(
              (a) =>
                a.type === "depository" &&
                a.connection_status !== "disconnected",
            )
            .map((a) => a.iso_currency_code)
            .filter((c) => /^[A-Z]{3}$/.test(c)),
        ),
      ].sort();
      if (!currencies.length) currencies.push(data.baseCurrency);
      if (!currencies.includes(filters.currency))
        filters.currency = currencies.includes(data.baseCurrency)
          ? data.baseCurrency
          : currencies[0];
      el("currency").innerHTML = currencies
        .map((c) => `<option>${esc(c)}</option>`)
        .join("");
      if (filters.projectionEnabled && data.projectionError)
        throw new Error("Revenue projections: " + data.projectionError);
      ready = true;
      render();
      if (!model.invalidAssignments.length)
        status(
          `Saved Plaid data · company date ${today}. Refresh reloads the latest saved sync.`,
        );
    } catch (e) {
      ready = false;
      for (const id of [
        "summary",
        "matrix",
        "liquidity",
        "charts",
        "flowTotals",
        "patterns",
      ])
        el(id).innerHTML = "";
      status("Cashflow unavailable: " + e.message);
      if (data?.projectionError && filters.projectionEnabled) {
        el("projectionEnabled").checked = true;
        el("projectionEnabled").disabled = false;
        el("projectionStatus").textContent =
          "Projections unavailable. Uncheck Add projections to planning to continue without that layer, or refresh to retry.";
      }
      el("overrides").innerHTML = "";
      el("accounts").innerHTML = "";
      el("plans").innerHTML = "";
      el("coverage").textContent = "";
      el("planScope").textContent = "";
    } finally {
      busy = false;
      el("refresh").disabled = false;
      el("matrix").setAttribute("aria-busy", "false");
    }
  }
  function allCashBalance() {
    const balances = data.accounts
      .filter(
        (a) =>
          a.type === "depository" &&
          a.iso_currency_code === filters.currency &&
          a.connection_status !== "disconnected",
      )
      .map((a) => M.cents(a.current_balance));
    return balances.length && balances.every((n) => n !== null)
      ? balances.reduce((a, b) => a + b, 0)
      : null;
  }
  function render() {
    if (!ready) return;
    const scrollLeft = el("matrix").scrollLeft,
      scrollTop = el("matrix").scrollTop;
    if (
      filters.selected !== "all" &&
      !data.accounts.some(
        (a) =>
          a.id === filters.selected &&
          a.type === "depository" &&
          a.iso_currency_code === filters.currency &&
          a.connection_status !== "disconnected",
      )
    )
      filters.selected = "all";
    model = M.build({ ...data, ...filters, whatIf, today });
    persist();
    el("charts").innerHTML = window.SiloCashflowCharts.render(
      filters.unit === "month"
        ? model
        : M.build({ ...data, ...filters, whatIf, unit: "month", today }),
      filters.currency,
    );
    for (const key of ["currency", "group", "unit", "horizon", "lookback"])
      el(key).value = filters[key];
    el("trend").checked = filters.trend;
    el("accounts").innerHTML =
      `<button class="cf-account" data-account="all" aria-pressed="${filters.selected === "all"}">All cash accounts<strong>${money(allCashBalance())}</strong><small>${esc(filters.currency)} · saved current balances</small></button>` +
      data.accounts
        .map((a) => {
          const selectable =
            a.type === "depository" &&
            a.iso_currency_code === filters.currency &&
            a.connection_status !== "disconnected";
          const value = M.cents(a.current_balance),
            formatted =
              value === null
                ? "—"
                : /^[A-Z]{3}$/.test(a.iso_currency_code)
                  ? new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: a.iso_currency_code,
                    }).format(value / 100)
                  : "—";
          return `<button class="cf-account" data-account="${esc(a.id)}" aria-pressed="${filters.selected === a.id}" ${selectable ? "" : "disabled"}>${esc(a.name)} ${a.mask ? "· " + esc(a.mask) : ""}<strong>${esc(formatted)}</strong><small>${esc(a.type === "depository" ? "Cash" : a.type + " · not cash")} · ${esc(a.connection_status)}</small><small>Balance as of ${esc(a.balance_updated_at?.slice(0, 16).replace("T", " ") || "unknown")} UTC</small></button>`;
        })
        .join("");
    const end = model.ending.at(-1),
      stats = [
        [
          "Saved cash balance",
          model.currentCash,
          `${model.cash.length} cash accounts · ${filters.currency}`,
        ],
        ["Projected ending cash", end, short(model.futureEnd)],
        ["Lowest projected cash", model.low, short(model.lowDate)],
        [
          "Uncategorized activity",
          String(model.uncategorized),
          "Included in cash movements",
        ],
      ];
    el("summary").innerHTML = stats
      .map(
        ([label, value, note]) =>
          `<div class="cf-stat"><small>${label}</small><strong class="${typeof value === "number" && value < 0 ? "cf-neg" : ""}">${typeof value === "string" ? value : money(value)}</strong><span>${esc(note)}</span></div>`,
      )
      .join("");
    const first = model.cols.findIndex((c) => c.kind === "forecast");
    const cls = (c, i) =>
      `${c.kind === "forecast" ? "cf-future" : ""} ${i === first ? "cf-boundary" : ""}`;
    const total = (label, values, rowClass = "cf-total") =>
      `<tr class="${rowClass}"><th scope="row">${label}</th>${model.cols.map((c, i) => `<td class="${cls(c, i)} ${values[i] < 0 ? "cf-neg" : ""}">${money(values[i])}</td>`).join("")}</tr>`;
    let body = "";
    for (const direction of ["in", "out"]) {
      body += total(
        direction === "in" ? "Money in" : "Money out",
        direction === "in" ? model.inflow : model.outflow,
      );
      model.rows.forEach((r, index) => {
        if (r.direction !== direction) return;
        body += `<tr><th scope="row">${esc(r.label)}</th>${model.cols
          .map((c, i) => {
            const amount = c.kind === "actual" ? r.actual[i] : r.forecast[i];
            return `<td class="${cls(c, i)} ${r.overrides[i].length ? "cf-manual" : ""}"><button data-cell="${index}:${i}" aria-label="${esc(r.label + " " + c.start + " to " + c.end)}" title="${c.kind === "forecast" ? esc("Trend " + money(r.trend[i]) + " · planned " + money(r.planned[i]) + " · manual " + money(r.manual[i])) : "View bank movements"}">${money(amount)}</button></td>`;
          })
          .join("")}</tr>`;
      });
    }
    body +=
      total("Net cash movement", model.net) +
      total("Projected ending cash", model.ending);
    el("matrix").innerHTML = model.cash.length
      ? `<table><thead><tr><th scope="col">${filters.group === "coa" ? "COA bucket" : "Cashflow category"}<small>${filters.currency}</small></th>${model.cols.map((c, i) => `<th scope="col" class="${cls(c, i)}" ${i === first ? 'id="forecastStart"' : ""}>${short(c.start)}${c.end !== c.start ? " – " + short(c.end) : ""}<small>${c.kind === "actual" ? "Actual" : "Forecast"} · ${c.start.slice(0, 4)}</small></th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`
      : '<div class="cf-empty">Connect a Plaid checking or savings account to see cashflow. Credit cards and investments are outside cash balances.</div>';
    el("matrix").scrollLeft = scrollLeft;
    el("matrix").scrollTop = scrollTop;
    renderLiquidity(cls, total);
    const days = model.coverage.map((c) => c.days);
    el("coverage").textContent =
      `${model.postedCount} posted movements · ${model.pending} pending omitted · ${model.excluded} excluded from coding included. Trend history: ${days.length ? Math.min(...days) + "–" + Math.max(...days) + " completed days" : "none"}${days.some((d) => d < 30) ? " · Limited history" : ""}.`;
    el("add").disabled = !model.companyPlans || !model.cash.length;
    el("overrideAdd").disabled = el("add").disabled;
    el("planScope").textContent =
      `Company plans · ${data.baseCurrency}${model.companyPlans ? "" : " · switch to All cash accounts / " + data.baseCurrency + " to include and edit"}`;
    renderOverrides();
    renderPlanning();
    el("plans").innerHTML = data.plans.length
      ? data.plans
          .map(
            (p) =>
              `<div class="cf-plan"><span>${esc(p.label)}<small>${esc(categoryName(p.category))} · ${esc(p.kind === "recurring" ? p.cadence : "One-time")} · ${esc(p.start_date)} · ${esc(accountName(p.account_id))}${p.counter_account_id ? (Number(p.amount) < 0 ? " → " : " ← ") + esc(accountName(p.counter_account_id)) : ""}${p.end_date ? " → " + esc(p.end_date) : ""}</small></span><b>${esc(new Intl.NumberFormat("en-US", { style: "currency", currency: data.baseCurrency }).format(Number(p.amount)))}</b><button class="bcn-btn" data-plan="${esc(p.id)}" ${model.companyPlans ? "" : "disabled"}>Edit</button></div>`,
          )
          .join("")
      : '<p class="cf-empty">Add known payments and receipts to shape the forecast.</p>';
  }
  function categoryName(key) {
    return (
      M.catalog(data.chart).get(key)?.name ||
      (key === "uncategorized"
        ? "Uncategorized"
        : key?.startsWith("flow|")
          ? key.slice(5)
          : key?.startsWith("coa|")
            ? "Saved COA bucket"
            : key || "Planning")
    );
  }
  function openPlan(id) {
    if (!ready || !model.companyPlans) return;
    editing = data.plans.find((p) => p.id === id) || null;
    const options = [
      ["uncategorized", "Uncategorized"],
      ...[
        "Operating",
        "Card paydowns",
        "Investing",
        "Financing",
        "Transfers",
      ].map((s) => ["flow|" + s, s + " (cashflow category)"]),
      ...[...M.catalog(data.chart)].map(([key, c]) => [key, c.name]),
    ];
    if (editing?.category && !options.some((o) => o[0] === editing.category))
      options.push([editing.category, categoryName(editing.category)]);
    el("category").innerHTML = options
      .map(
        ([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`,
      )
      .join("");
    el("planTitle").textContent = editing
      ? "Edit planned movement"
      : "Add planned movement";
    el("label").value = editing?.label || "";
    el("category").value = editing?.category || "uncategorized";
    el("direction").value = Number(editing?.amount) > 0 ? "in" : "out";
    el("amount").value = editing ? Math.abs(Number(editing.amount)) : "";
    el("kind").value = editing?.kind || "one_time";
    el("cadence").value = editing?.cadence || "monthly";
    el("start").value = editing?.start_date || model.futureStart;
    el("end").value = editing?.end_date || "";
    el("archive").hidden = !editing;
    el("planError").textContent = "";
    accountOptions("plan", editing?.account_id, editing?.counter_account_id);
    kindChanged();
    el("planDialog").showModal();
  }
  function kindChanged() {
    const one = el("kind").value === "one_time";
    el("cadence").disabled = one;
    el("end").disabled = one;
  }
  async function save(archive = false) {
    if (busy) return;
    const start = el("start").value,
      end = el("kind").value === "recurring" ? el("end").value || null : null,
      amount = Number(el("amount").value);
    if (
      !archive &&
      (!el("label").value.trim() ||
        !M.validDate(start) ||
        (end && (!M.validDate(end) || end < start)) ||
        !Number.isFinite(amount) ||
        amount <= 0)
    ) {
      el("planError").textContent =
        "Enter a name, positive amount and valid date range.";
      return;
    }
    busy = true;
    for (const button of el("planForm").querySelectorAll("button"))
      button.disabled = true;
    try {
      const current = await cfg.ensureActiveCompany(db);
      if (current?.id !== company.id)
        throw new Error("Company changed. Reload this page before saving.");
      const payload = archive
        ? { is_active: false }
        : {
            label: el("label").value.trim(),
            category: el("category").value,
            amount:
              ((el("direction").value === "out" ? -1 : 1) *
                Math.round(amount * 100)) /
              100,
            kind: el("kind").value,
            cadence:
              el("kind").value === "recurring" ? el("cadence").value : null,
            start_date: start,
            end_date: end,
            account_id: el("planAccount").value || null,
            counter_account_id: el("planCounter").value || null,
          };
      payload.updated_at = new Date().toISOString();
      payload.updated_by = userId;
      if (editing) {
        let query = db
          .from("cash_forecast_items")
          .update(payload)
          .eq("company_entity_id", company.id)
          .eq("id", editing.id);
        if (editing.updated_at)
          query = query.eq("updated_at", editing.updated_at);
        await result(query.select("id").single());
      } else
        await result(
          db
            .from("cash_forecast_items")
            .insert({ ...payload, company_entity_id: company.id })
            .select("id")
            .single(),
        );
      el("planDialog").close();
      busy = false;
      await load();
    } catch (e) {
      el("planError").textContent = "Could not save plan: " + e.message;
    } finally {
      busy = false;
      for (const button of el("planForm").querySelectorAll("button"))
        button.disabled = false;
    }
  }
  function accountName(id) {
    return (
      data.accounts.find((a) => a.id === id)?.name ||
      (id ? "Account unavailable" : "Unassigned cash movements")
    );
  }
  function accountOptions(prefix, account = "", counter = "") {
    const options = data.accounts.filter(
      (a) =>
        a.iso_currency_code === data.baseCurrency &&
        a.connection_status !== "disconnected",
    );
    el(prefix + "Account").innerHTML =
      '<option value="">Unassigned cash movements</option>' +
      options
        .filter((a) => a.type === "depository")
        .map(
          (a) =>
            `<option value="${esc(a.id)}">${esc(a.name)} ${a.mask ? "· " + esc(a.mask) : ""}</option>`,
        )
        .join("");
    el(prefix + "Counter").innerHTML =
      '<option value="">No linked account</option>' +
      options
        .filter((a) =>
          ["depository", "credit", "loan", "investment"].includes(a.type),
        )
        .map(
          (a) =>
            `<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.type)}</option>`,
        )
        .join("");
    for (const [key, value] of [
      ["Account", account],
      ["Counter", counter],
    ]) {
      if (value && !options.some((a) => a.id === value))
        el(prefix + key).insertAdjacentHTML(
          "beforeend",
          `<option value="${esc(value)}">Account unavailable · reassign to save</option>`,
        );
      el(prefix + key).value = value || "";
    }
  }
  function renderLiquidity(cls, total) {
    const scroll = el("liquidity").scrollLeft;
    const header = `<thead><tr><th scope="col">Account<small>${filters.currency} · ending balance</small></th>${model.cols.map((c, i) => `<th scope="col" class="${cls(c, i)}">${short(c.start)}${c.end !== c.start ? " – " + short(c.end) : ""}<small>${c.kind === "actual" ? "Reconstructed" : "Forecast"}</small></th>`).join("")}</tr></thead>`;
    let body = model.liquidity
      .filter((a) => a.type === "depository")
      .map((a) => total(esc(a.label), a.ending, "cf-balance-row"))
      .join("");
    if (model.unallocatedEnding.some((n) => n))
      body += total(
        "Unassigned cash movements",
        model.unallocatedEnding,
        "cf-balance-row",
      );
    body += total("Total cash", model.liquidityTotal);
    body += model.liquidity
      .filter((a) => a.type !== "depository")
      .map((a) =>
        total(
          esc(a.label) +
            `<small>${esc(["credit", "loan"].includes(a.type) ? "Balance owed · outside cash" : a.type + " · outside cash")}</small>`,
          a.ending,
          "cf-balance-row",
        ),
      )
      .join("");
    el("liquidity").innerHTML = model.cash.length
      ? `<table>${header}<tbody>${body}</tbody></table>`
      : '<p class="cf-empty">Connected cash accounts will appear here.</p>';
    el("liquidity").scrollLeft = scroll;
    if (model.invalidAssignments.length)
      status(
        `${model.invalidAssignments.length} assumptions reference unavailable accounts and are omitted. Reassign those accounts in the saved movement or override.`,
      );
  }
  function renderOverrides() {
    el("overrides").innerHTML = data.overrides.length
      ? data.overrides
          .map(
            (o) =>
              `<div class="cf-plan"><span>${esc(o.category_label)} <b class="cf-badge">Manual</b><small>${esc(o.start_date)} → ${esc(o.end_date)} · ${o.direction === "out" ? "Out" : "In"} · ${esc(accountName(o.account_id))}</small></span><b>${esc(new Intl.NumberFormat("en-US", { style: "currency", currency: o.currency }).format(Number(o.amount)))}</b><button class="bcn-btn" data-override="${esc(o.id)}" ${model.companyPlans ? "" : "disabled"}>Edit / reset</button></div>`,
          )
          .join("")
      : '<p class="cf-empty">Forecast cells start with your trends and plans. Override any forecast total when you know more.</p>';
  }
  function overrideCategories(selected) {
    const choices =
      el("overrideGroup").value === "cashflow"
        ? [
            "Operating",
            "Card paydowns",
            "Investing",
            "Financing",
            "Transfers",
            "Uncategorized",
            "Planning",
          ].map((flow) => ({ key: flow, name: flow, flow }))
        : [
            {
              key: "uncategorized",
              name: "Uncategorized",
              flow: "Uncategorized",
            },
            ...[...M.catalog(data.chart).values()],
          ];
    if (selected && !choices.some((c) => c.key === selected.key))
      choices.push(selected);
    el("overrideCategory").innerHTML = choices
      .map(
        (c) =>
          `<option value="${esc(c.key)}" data-flow="${esc(c.flow)}">${esc(c.name)}</option>`,
      )
      .join("");
    if (selected) el("overrideCategory").value = selected.key;
  }
  function openOverride(id, cell) {
    if (!ready || !model.companyPlans) return;
    overrideEditing = data.overrides.find((o) => o.id === id) || null;
    const row = cell ? model.rows[cell.r] : null,
      col = cell
        ? model.cols[cell.i]
        : model.cols.find((c) => c.kind === "forecast");
    if (!col) return;
    const o = overrideEditing;
    el("overrideGroup").value = o?.scope_group || (row ? filters.group : "coa");
    el("overrideDirection").value = o?.direction || row?.direction || "out";
    const category = o
      ? { key: o.category_key, name: o.category_label, flow: o.flow_key }
      : row
        ? {
            key: filters.group === "cashflow" ? row.flow : row.categoryKey,
            name: row.label,
            flow: row.flow,
          }
        : null;
    overrideCategories(category);
    el("overrideStart").value = o?.start_date || col.start;
    el("overrideEnd").value = o?.end_date || col.end;
    el("overrideDate").value = o?.payment_date || col.end;
    el("overrideAmount").value = o
      ? o.amount
      : row
        ? Math.abs(row.forecast[cell.i]) / 100
        : "";
    el("overrideContext").textContent = o
      ? `Saved ${o.start_date} through ${o.end_date}. This range stays fixed when you switch day/week/month views.`
      : row
        ? `Current forecast for this cell: ${money(row.forecast[cell.i])}. Enter its replacement total.`
        : "Choose any COA bucket, including bank, card or other balance sheet accounts.";
    for (const key of [
      "overrideGroup",
      "overrideDirection",
      "overrideCategory",
      "overrideStart",
      "overrideEnd",
    ])
      el(key).disabled = !!o;
    accountOptions("override", o?.account_id, o?.counter_account_id);
    el("resetOverride").hidden = !o;
    el("overrideError").textContent = "";
    el("detailDialog").close();
    el("overrideDialog").showModal();
  }
  async function saveOverride(reset = false) {
    if (busy || !ready || !model.companyPlans) return;
    const start = el("overrideStart").value,
      end = el("overrideEnd").value,
      payment = el("overrideDate").value,
      amount = Number(el("overrideAmount").value);
    if (
      !reset &&
      (!M.validDate(start) ||
        !M.validDate(end) ||
        end < start ||
        !M.validDate(payment) ||
        payment < start ||
        payment > end ||
        !el("overrideAmount").value.trim() ||
        !Number.isFinite(amount) ||
        amount < 0)
    ) {
      el("overrideError").textContent =
        "Enter valid dates and a total of zero or more. Payment date must be inside the range.";
      return;
    }
    if (!reset && !overrideEditing && start <= today) {
      el("overrideError").textContent =
        "New overrides must start after today. Actual transactions remain unchanged.";
      return;
    }
    const option = el("overrideCategory").selectedOptions[0];
    if (!reset && !option) return;
    busy = true;
    for (const b of el("overrideForm").querySelectorAll("button"))
      b.disabled = true;
    try {
      const active = await cfg.ensureActiveCompany(db);
      if (active?.id !== company.id)
        throw new Error("Company changed. Reload before saving.");
      const payload = reset
        ? { is_active: false }
        : {
            currency: data.baseCurrency,
            scope_group: el("overrideGroup").value,
            category_key: el("overrideCategory").value,
            category_label: option.textContent,
            flow_key: option.dataset.flow,
            direction: el("overrideDirection").value,
            start_date: start,
            end_date: end,
            payment_date: payment,
            amount: Math.round(amount * 100) / 100,
            account_id: el("overrideAccount").value || null,
            counter_account_id: el("overrideCounter").value || null,
          };
      if (overrideEditing) {
        let query = db
          .from("cash_forecast_overrides")
          .update(payload)
          .eq("company_entity_id", company.id)
          .eq("id", overrideEditing.id)
          .eq("updated_at", overrideEditing.updated_at);
        await result(query.select("id").single());
      } else
        await result(
          db
            .from("cash_forecast_overrides")
            .insert({ ...payload, company_entity_id: company.id })
            .select("id")
            .single(),
        );
      el("overrideDialog").close();
      busy = false;
      await load();
    } catch (e) {
      el("overrideError").textContent =
        e.code === "23P01"
          ? "An override already covers part of these dates. Edit or reset it from Manual overrides."
          : e.code === "PGRST116"
            ? "This override changed in another session. Close and refresh before editing again."
            : "Could not save override: " + e.message;
    } finally {
      busy = false;
      for (const b of el("overrideForm").querySelectorAll("button"))
        b.disabled = false;
    }
  }
  function detail(cell) {
    const [r, i] = cell.split(":").map(Number),
      row = model.rows[r],
      col = model.cols[i];
    if (!row || !col) return;
    el("detailTitle").textContent =
      row.label + " · " + short(col.start) + " – " + short(col.end);
    if (row.flow === "What if") {
      el("detailBody").innerHTML =
        "<p>This is an unsaved scenario movement. Remove or replace it in the What if strip, or use Add movement to save an assumption.</p>";
      el("detailDialog").showModal();
      return;
    }
    if (col.kind === "actual")
      el("detailBody").innerHTML =
        row.transactions[i]
          .map(
            (t) =>
              `<div class="cf-plan"><span>${esc(t.clean_merchant || t.description)}<small>${esc(t.txn_date)} · ${esc(t.category)}</small></span><b>${money(t.movement)}</b>${t.batch_id ? `<a href="transactions.html?batch=${encodeURIComponent(t.batch_id)}&amp;company=${encodeURIComponent(company.id)}">Review</a>` : ""}</div>`,
          )
          .join("") || "<p>No posted movements in this cell.</p>";
    else {
      const overlapping = data.overrides.filter(
        (o) =>
          o.currency === filters.currency &&
          o.direction === row.direction &&
          o.start_date <= col.end &&
          o.end_date >= col.start &&
          (o.scope_group === "cashflow"
            ? o.category_key === row.flow
            : filters.group === "cashflow"
              ? o.flow_key === row.flow
              : o.category_key === row.categoryKey),
      );
      el("detailBody").innerHTML =
        `<p>Bank trend: ${money(row.trend[i])}</p><p>Planned movements: ${money(row.planned[i])}</p><p>Manual override: ${money(row.manual[i])}</p><p>Revenue projections: ${money(row.projection[i])}</p><p>What-if scenario: ${money(row.whatif[i])}</p><p><b>Projected total: ${money(row.forecast[i])}</b></p><div class="cf-detail-actions">${model.companyPlans ? (overlapping.length ? overlapping.map((o) => `<button class="bcn-btn" data-edit-override="${esc(o.id)}">Edit ${esc(o.category_label)} · ${short(o.start_date)}–${short(o.end_date)}</button>`).join("") : `<button class="bcn-btn bcn-btn--primary" data-new-override="${r}:${i}">Override this total</button>`) : "<p>Switch to All cash accounts in the base currency to edit assumptions.</p>"}</div>`;
    }
    el("detailDialog").showModal();
  }
  function renderPlanning() {
    const future = model.cols
        .map((c, i) => (c.kind === "forecast" ? i : -1))
        .filter((i) => i >= 0),
      sum = (values) => future.reduce((n, i) => n + values[i], 0);
    el("flowTotals").innerHTML =
      `<span>${short(model.futureStart)}–${short(model.futureEnd)}</span><span>Money in<strong>${money(sum(model.inflow))}</strong></span><span>Money out<strong>${money(-sum(model.outflow))}</strong></span><span>Net<strong>${money(sum(model.net))}</strong></span><span>Projections<strong>${money(model.projectionInfo.total)}</strong></span><span>What-if impact<strong>${money(model.whatIfTotal)}</strong></span>`;
    el("timing").checked = filters.timing;
    el("timingSummary").textContent =
      `Recurring timing · ${filters.timing ? model.patterns.length + " patterns detected" : "daily averages selected"}`;
    el("patterns").innerHTML =
      model.patterns
        .map(
          (p) =>
            `<div class="cf-pattern"><span>${esc(p.merchant)} · ${esc(p.category)}<br>${esc(p.cadence)} · ${p.samples} observed payments</span><span>${p.nextDate ? short(p.nextDate) : "Outside horizon"} · ${money(p.amount)}</span></div>`,
        )
        .join("") ||
      "<p>No reliable recurring pattern in this history window. Irregular activity uses daily averages.</p>";
    el("projectionEnabled").checked = filters.projectionEnabled;
    el("collectionPercent").value = filters.collectionPercent;
    el("collectionLag").value = filters.collectionLag;
    for (const id of [
      "projectionEnabled",
      "collectionPercent",
      "collectionLag",
    ])
      el(id).disabled = !model.companyPlans || !!data.projectionError;
    el("projectionStatus").textContent = data.projectionError
      ? "Projections unavailable: " + data.projectionError
      : `${data.projections.length} future active location/date projections available · ${data.baseCurrency}. ${model.projectionInfo.enabled ? model.projectionInfo.count + " receipts included in this horizon." : "Planning layer off in this view."}`;
    for (const id of [
      "whatIfAdd",
      "whatIfLabel",
      "whatIfDirection",
      "whatIfAmount",
      "whatIfDate",
    ])
      el(id).disabled = !model.companyPlans;
    if (!el("whatIfDate").value) el("whatIfDate").value = model.futureStart;
    el("whatIfDate").min = model.futureStart;
    el("whatIfDate").max = M.addMonths(today, 6);
    el("whatIfItems").innerHTML = whatIf
      .map(
        (w) =>
          `<span class="cf-whatif-chip">${esc(w.label)} · ${esc(w.date)} · ${esc(new Intl.NumberFormat("en-US", { style: "currency", currency: w.currency }).format(w.amount))}${w.date > model.futureEnd ? " · outside horizon" : ""}<button type="button" data-remove-whatif="${esc(w.id)}" aria-label="Remove ${esc(w.label)}">×</button></span>`,
      )
      .join("");
    el("whatIfStatus").textContent = model.companyPlans
      ? "Preview only · cleared when you reload this page. Use Add movement to save an assumption."
      : "Use All cash accounts in the base currency to preview custom movements.";
  }
  function addWhatIf() {
    if (!ready || !model.companyPlans) return;
    const amount = Number(el("whatIfAmount").value),
      date = el("whatIfDate").value,
      label = el("whatIfLabel").value.trim();
    if (
      !label ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !M.validDate(date) ||
      date <= today ||
      date > M.addMonths(today, 6)
    ) {
      el("whatIfStatus").textContent =
        "Enter a description, positive amount and a future date within six months.";
      return;
    }
    whatIf.push({
      id: "preview-" + ++whatIfSequence,
      currency: filters.currency,
      date,
      label,
      amount:
        ((el("whatIfDirection").value === "out" ? -1 : 1) *
          Math.round(amount * 100)) /
        100,
    });
    render();
    el("whatIfLabel").value = "";
    el("whatIfAmount").value = "";
  }
  async function boot() {
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY)
      throw new Error("Missing application configuration");
    db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const session = await result(db.auth.getSession());
    if (!session.session) {
      location.href =
        "/pages/login.html?next=" + encodeURIComponent(location.pathname);
      return;
    }
    userId = session.session.user.id;
    company = await cfg.ensureActiveCompany(db);
    if (!company?.id) throw new Error("Select a company first");
    const [finance, executive] = await Promise.all([
      result(db.rpc("can_manage_journal_entries")),
      result(db.rpc("is_exec_or_owner")),
    ]);
    if (!finance && !executive) throw new Error("Finance access is required");
    window.SiloChrome?.mount({
      appEl: "#silo-app",
      active: "finance/cash-forecast",
      user: { email: session.session.user.email },
      crumbs: ["Accounting", "Cashflow"],
      supabaseClient: db,
    });
    restore();
    el("refresh").addEventListener("click", load);
    el("timing").addEventListener("change", () => {
      if (!ready) return;
      filters.timing = el("timing").checked;
      render();
    });
    el("projectionControls").addEventListener("change", (e) => {
      if (
        !ready &&
        data?.projectionError &&
        e.target.id === "projectionEnabled" &&
        !e.target.checked
      ) {
        filters.projectionEnabled = false;
        persist();
        load();
        return;
      }
      if (!ready || !model.companyPlans || data.projectionError) return;
      const id = e.target.id;
      if (id === "projectionEnabled")
        filters.projectionEnabled = e.target.checked;
      else if (["collectionPercent", "collectionLag"].includes(id)) {
        const n = Number(e.target.value);
        if (
          e.target.value === "" ||
          !Number.isFinite(n) ||
          n < 0 ||
          n > (id === "collectionLag" ? 60 : 100) ||
          (id === "collectionLag" && !Number.isInteger(n))
        ) {
          el("projectionStatus").textContent =
            "Enter a collection percentage from 0–100 and a whole-day delay from 0–60.";
          return;
        }
        filters[id] = n;
      } else return;
      render();
    });
    el("whatIfForm").addEventListener("submit", (e) => {
      e.preventDefault();
      addWhatIf();
    });
    el("whatIfClear").addEventListener("click", () => {
      whatIf = [];
      render();
    });
    el("whatIfItems").addEventListener("click", (e) => {
      const b = e.target.closest("[data-remove-whatif]");
      if (b) {
        whatIf = whatIf.filter((w) => w.id !== b.dataset.removeWhatif);
        render();
      }
    });

    el("add").addEventListener("click", () => openPlan());
    el("overrideAdd").addEventListener("click", () => openOverride());
    el("overrides").addEventListener("click", (e) => {
      const b = e.target.closest("[data-override]");
      if (b && !b.disabled) openOverride(b.dataset.override);
    });
    el("overrideGroup").addEventListener("change", () => overrideCategories());
    el("overrideForm").addEventListener("submit", (e) => {
      e.preventDefault();
      saveOverride();
    });
    el("resetOverride").addEventListener("click", () => saveOverride(true));
    el("overrideDialog").addEventListener("cancel", (e) => {
      if (busy) e.preventDefault();
    });
    el("detailBody").addEventListener("click", (e) => {
      const edit = e.target.closest("[data-edit-override]"),
        add = e.target.closest("[data-new-override]");
      if (edit) openOverride(edit.dataset.editOverride);
      if (add) {
        const [r, i] = add.dataset.newOverride.split(":").map(Number);
        openOverride(null, { r, i });
      }
    });
    el("controls").addEventListener("change", (e) => {
      const key = e.target.id;
      if (!Object.hasOwn(filters, key) || !ready) return;
      filters[key] =
        key === "trend"
          ? e.target.checked
          : ["horizon", "lookback"].includes(key)
            ? Number(e.target.value)
            : e.target.value;
      render();
    });
    el("accounts").addEventListener("click", (e) => {
      const button = e.target.closest("[data-account]");
      if (button && !button.disabled && ready) {
        filters.selected = button.dataset.account;
        render();
      }
    });
    el("plans").addEventListener("click", (e) => {
      const button = e.target.closest("[data-plan]");
      if (button && !button.disabled) openPlan(button.dataset.plan);
    });
    el("matrix").addEventListener("click", (e) => {
      const button = e.target.closest("[data-cell]");
      if (button && ready) detail(button.dataset.cell);
    });
    el("jump").addEventListener("click", () => {
      const start = el("forecastStart");
      if (start) {
        el("matrix").scrollLeft = Math.max(0, start.offsetLeft - 230);
        el("liquidity").scrollLeft = el("matrix").scrollLeft;
      }
    });
    document.querySelectorAll("[data-close]").forEach((b) =>
      b.addEventListener("click", () => {
        if (!busy) el(b.dataset.close).close();
      }),
    );
    el("kind").addEventListener("change", kindChanged);
    el("planForm").addEventListener("submit", (e) => {
      e.preventDefault();
      save();
    });
    el("archive").addEventListener("click", () => save(true));
    el("planDialog").addEventListener("cancel", (e) => {
      if (busy) e.preventDefault();
    });
    for (const [from, to] of [
      ["matrix", "liquidity"],
      ["liquidity", "matrix"],
    ])
      el(from).addEventListener("scroll", () => {
        if (Math.abs(el(to).scrollLeft - el(from).scrollLeft) > 1)
          el(to).scrollLeft = el(from).scrollLeft;
      });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") load();
    });
    await load();
  }
  boot().catch((e) => status("Cashflow unavailable: " + e.message));
})();
