import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const root = new URL("../../v2/", import.meta.url),
  window = {};
vm.runInNewContext(await readFile(new URL("cashflow-model.js", root), "utf8"), {
  window,
});
vm.runInNewContext(
  await readFile(new URL("cashflow-charts.js", root), "utf8"),
  { window, Intl },
);
const M = window.SiloCashflow;
const account = {
  id: "bank",
  type: "depository",
  iso_currency_code: "USD",
  current_balance: 1000,
  source_id: "source",
  connection_status: "active",
};
const txn = (id, amount, extra = {}) => ({
  id,
  external_transaction_id: id,
  plaid_account_id: "bank",
  txn_date: "2026-09-01",
  origin: "plaid",
  provider_status: "posted",
  currency: "USD",
  status: "uncoded",
  amount,
  ...extra,
});
const base = {
  today: "2026-09-13",
  accounts: [account],
  sources: [{ id: "source", qbo_connection_id: "conn" }],
  chart: [
    {
      connection_id: "conn",
      qbo_account_id: "rent",
      name: "Rent",
      account_type: "Expense",
    },
  ],
};
const build = (extra) => M.build({ ...base, ...extra });
const sum = (a) => a.reduce((x, y) => x + y, 0);
const actual = (m) => sum(m.net.filter((n, i) => m.cols[i].kind === "actual"));
const plan = (extra = {}) => ({
  id: "p",
  label: "Rent",
  category: M.coaKey("conn", "rent"),
  amount: -120,
  kind: "recurring",
  cadence: "monthly",
  start_date: "2026-09-14",
  is_active: true,
  ...extra,
});
test("posted uncoded and excluded cash is included; pending, removed, cards, currency and duplicate rows are not", () => {
  const m = build({
    accounts: [
      account,
      { ...account, id: "card", type: "credit", current_balance: 500 },
    ],
    transactions: [
      txn("a", 50),
      txn("b", -20, { status: "excluded" }),
      txn("c", 100, { provider_status: "pending" }),
      txn("d", 100, { provider_status: "removed" }),
      txn("e", 100, { plaid_account_id: "card" }),
      txn("f", 100, { currency: "EUR" }),
      txn("a", 50),
    ],
  });
  assert.equal(actual(m), -3000);
  assert.equal(m.currentCash, 100000);
  assert.equal(m.postedCount, 2);
  assert.equal(m.pending, 1);
  assert.equal(m.excluded, 1);
  assert.equal(m.uncategorized, 2);
});
test("categorization moves rows without changing cash or baseline trend", () => {
  const a = build({ transactions: [txn("a", 120)] }),
    b = build({
      transactions: [
        txn("a", 120, { qbo_account_id: "rent", status: "coded" }),
      ],
    });
  assert.equal(actual(a), actual(b));
  assert.equal(a.ending.at(-1), b.ending.at(-1));
  assert.equal(b.rows[0].label, "Rent");
  assert.equal(a.rows[0].label, "Uncategorized");
});
test("day, week, month and cashflow grouping preserve ending cash and daily low", () => {
  const results = ["day", "week", "month"].flatMap((unit) =>
    ["coa", "cashflow"].map((group) =>
      build({
        unit,
        group,
        transactions: [
          txn("a", 100),
          txn("b", -50, { qbo_account_id: "rent" }),
        ],
        plans: [
          plan({ kind: "one_time", amount: -500, start_date: "2026-09-15" }),
          plan({
            id: "p2",
            kind: "one_time",
            amount: 500,
            start_date: "2026-09-25",
          }),
        ],
      }),
    ),
  );
  for (const m of results) {
    assert.equal(m.ending.at(-1), results[0].ending.at(-1));
    assert.equal(m.low, results[0].low);
    assert.equal(m.lowDate, results[0].lowDate);
    assert.equal(actual(m), -5000);
  }
});
test("missing balance stays unknown; saved balance is not reduced by historical cash again", () => {
  const m = build({ trend: false, transactions: [txn("a", 100)] });
  assert.equal(m.ending.at(-1), 100000);
  const missing = build({ accounts: [{ ...account, current_balance: null }] });
  assert.equal(missing.currentCash, null);
  assert.equal(missing.ending.at(-1), null);
  assert.equal(missing.low, null);
  assert.equal(build({ accounts: [] }).currentCash, null);
});
test("recurring plan replaces matching category and direction; one-time adds; ends restore trend", () => {
  const transactions = [txn("a", 120, { qbo_account_id: "rent" })];
  const m = build({
    unit: "day",
    transactions,
    plans: [
      plan({ end_date: "2026-09-14" }),
      plan({ id: "extra", kind: "one_time", amount: -5 }),
    ],
  });
  const row = m.rows[0],
    first = m.cols.findIndex((c) => c.kind === "forecast");
  assert.equal(row.forecast[first], -12500);
  assert.equal(row.trend[first], 0);
  assert.equal(row.trend[first + 1], -1000);
  const flow = build({
    transactions,
    plans: [plan({ category: "flow|Operating" })],
  });
  assert.equal(sum(flow.rows.flatMap((r) => r.trend)), 0);
  const opposite = build({ transactions, plans: [plan({ amount: 120 })] });
  assert.ok(sum(opposite.rows.flatMap((r) => r.trend)) < 0);
});
test("company plans do not enter individual account or foreign currency views", () => {
  assert.equal(
    build({ selected: "bank", trend: false, plans: [plan()] }).ending.at(-1),
    100000,
  );
  assert.equal(
    build({
      currency: "EUR",
      accounts: [{ ...account, iso_currency_code: "EUR" }],
      trend: false,
      plans: [plan()],
    }).ending.at(-1),
    100000,
  );
});
test("transfers are actual cash movements but not projected trends, even while uncoded", () => {
  const m = build({
    transactions: [txn("a", 50, { accounting_treatment: "transfer" })],
  });
  assert.equal(actual(m), -5000);
  assert.equal(m.ending.at(-1), 100000);
});
test("month end recurrences re-anchor and obey date bounds", () => {
  assert.deepEqual(
    Array.from(
      M.occurrences(
        plan({ start_date: "2026-01-31" }),
        "2026-02-01",
        "2026-05-01",
      ),
    ),
    ["2026-02-28", "2026-03-31", "2026-04-30"],
  );
  assert.deepEqual(
    Array.from(
      M.occurrences(
        plan({ start_date: "2024-02-29", cadence: "annual" }),
        "2025-01-01",
        "2028-12-31",
      ),
    ),
    ["2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"],
  );
  assert.equal(M.validDate("2026-02-30"), false);
});
test("daily low catches an intra-month shortage hidden by monthly net", () => {
  const m = build({
    unit: "month",
    trend: false,
    plans: [
      plan({ kind: "one_time", amount: -1500, start_date: "2026-09-14" }),
      plan({
        id: "b",
        kind: "one_time",
        amount: 1500,
        start_date: "2026-09-20",
      }),
    ],
  });
  assert.equal(m.low, -50000);
  assert.equal(m.lowDate, "2026-09-14");
  assert.equal(m.ending.at(-1), 100000);
});
test("today is shown as actual but does not train incomplete-day trends; connections isolate COA ids", () => {
  const m = build({ transactions: [txn("a", 50, { txn_date: base.today })] });
  assert.equal(actual(m), -5000);
  assert.equal(m.ending.at(-1), 100000);
  const isolated = build({
    chart: [
      {
        connection_id: "another",
        qbo_account_id: "rent",
        name: "Wrong company account",
      },
    ],
    transactions: [
      txn("a", 50, {
        qbo_account_id: "rent",
        qbo_account_name: "Original rent",
      }),
    ],
  });
  assert.equal(isolated.rows[0].label, "Original rent");
});

const controller = await readFile(new URL("cashflow.js", root), "utf8");
function harness({ failTable, failSave = false, changedCompany = false } = {}) {
  const nodes = new Map(),
    calls = [];
  const el = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        value: "",
        innerHTML: "",
        textContent: "",
        open: false,
        disabled: false,
        checked: true,
        selectedOptions: [],
        scrollLeft: 0,
        scrollTop: 0,
        showModal() {
          this.open = true;
        },
        insertAdjacentHTML() {},
        setAttribute() {},
        addEventListener() {},
        querySelectorAll() {
          return [];
        },
        close() {
          this.open = false;
        },
      });
    return nodes.get(id);
  };
  const tables = {
    plaid_accounts: [account],
    plaid_connections: [{ id: undefined, status: "active" }],
    card_sources: base.sources,
    quickbooks_accounts: base.chart,
    cash_forecast_items: [],
    cash_forecast_overrides: [],
    revenue_projections: [],
    accounting_settings: { base_currency: "USD" },
    card_transactions: Array.from({ length: 501 }, (_, i) => txn("t" + i, 1)),
  };
  const db = {
    rpc() {
      return Promise.resolve({ data: base.today });
    },
    from(table) {
      const call = { table, filters: [], range: null, write: false };
      calls.push(call);
      const q = {
        select() {
          return q;
        },
        eq(...args) {
          call.filters.push(args);
          return q;
        },
        order() {
          return q;
        },
        range(a, b) {
          call.range = [a, b];
          return q;
        },
        in() {
          return q;
        },
        gte() {
          return q;
        },
        lte() {
          return q;
        },
        maybeSingle() {
          return q;
        },
        single() {
          return q;
        },
        insert() {
          call.write = true;
          return q;
        },
        update() {
          call.write = true;
          return q;
        },
        then(resolve, reject) {
          const values = tables[table];
          return Promise.resolve({
            data: call.write
              ? { id: "saved" }
              : call.range
                ? values.slice(call.range[0], call.range[1] + 1)
                : values,
            error:
              table === failTable || (call.write && failSave)
                ? { message: "Fixture unavailable" }
                : null,
          }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  const win = {
    SiloCashflow: M,
    SiloCashflowCharts: window.SiloCashflowCharts,
    __SILO_CONFIG__: {
      ensureActiveCompany: async () => ({
        id: changedCompany ? "other" : "co",
      }),
    },
  };
  const code =
    controller.slice(0, controller.indexOf("boot().catch")) +
    `window.test={projection(value){filters.projectionEnabled=value;},addWhatIf,pages,load,save,saveOverride,openOverride,render,set(){db=window.db;company={id:'co'};},edit(){editing={id:'existing'};},editOverride(){overrideEditing={id:'override',updated_at:'old'};}};})();`;
  win.db = db;
  vm.runInNewContext(code, {
    window: win,
    document: { getElementById: el },
    Intl,
    localStorage: { setItem() {} },
  });
  win.test.set();
  return { api: win.test, el, calls };
}
test("loader paginates every transaction and scopes every table to active company", async () => {
  const h = harness();
  await h.api.load();
  assert.match(h.el("coverage").textContent, /501 posted/);
  assert.equal(
    h.calls.filter((c) => c.table === "card_transactions").length,
    2,
  );
  for (const c of h.calls)
    assert.ok(
      c.filters.some(([k, v]) => k === "company_entity_id" && v === "co"),
    );
});
test("load failures clear previous forecast conclusions and block plans", async () => {
  const h = harness({ failTable: "card_transactions" });
  h.el("summary").innerHTML = "old cash";
  await h.api.load();
  assert.equal(h.el("summary").innerHTML, "");
  assert.equal(h.el("matrix").innerHTML, "");
  assert.equal(h.el("add").disabled, true);
  assert.match(h.el("status").textContent, /unavailable/);
});
test("unsaved open plan prevents refresh; company change prevents data reads", async () => {
  const h = harness();
  h.el("planDialog").open = true;
  await h.api.load();
  assert.equal(h.calls.length, 0);
  const changed = harness({ changedCompany: true });
  await changed.api.load();
  assert.equal(changed.calls.length, 0);
  assert.match(changed.el("status").textContent, /Company changed/);
});
test("failed plan save keeps dialog and values, with scoped update", async () => {
  const h = harness({ failSave: true });
  h.api.edit();
  h.el("planDialog").open = true;
  for (const [id, value] of Object.entries({
    label: "Payroll",
    start: "2026-09-15",
    kind: "one_time",
    amount: "100",
    direction: "out",
    category: "uncategorized",
  }))
    h.el(id).value = value;
  await h.api.save();
  assert.equal(h.el("planDialog").open, true);
  assert.equal(h.el("label").value, "Payroll");
  assert.match(h.el("planError").textContent, /Could not save/);
  assert.deepEqual(h.calls[0].filters, [
    ["company_entity_id", "co"],
    ["id", "existing"],
  ]);
});

const override = (extra = {}) => ({
  id: "override",
  currency: "USD",
  scope_group: "coa",
  category_key: M.coaKey("conn", "rent"),
  category_label: "Rent",
  flow_key: "Operating",
  direction: "out",
  start_date: "2026-10-01",
  end_date: "2026-10-31",
  payment_date: "2026-10-20",
  amount: 120000,
  is_active: true,
  ...extra,
});
const moneyMarket = {
  ...account,
  id: "market",
  name: "Money market",
  current_balance: 50000,
};
const divvy = {
  ...account,
  id: "divvy",
  name: "Divvy",
  type: "credit",
  current_balance: 120000,
};
test("80k Divvy estimate becomes 120k total, reducing cash another 40k and paying down the card once", () => {
  const key = M.coaKey("conn", "divvy");
  const m = build({
    today: "2026-09-30",
    trend: false,
    accounts: [{ ...account, current_balance: 200000 }, moneyMarket, divvy],
    chart: [
      {
        connection_id: "conn",
        qbo_account_id: "divvy",
        name: "Divvy",
        account_type: "Credit Card",
      },
    ],
    plans: [
      plan({
        category: key,
        amount: -80000,
        kind: "one_time",
        start_date: "2026-10-20",
        account_id: "bank",
        counter_account_id: "divvy",
      }),
    ],
    overrides: [
      override({
        category_key: key,
        category_label: "Divvy",
        flow_key: "Card paydowns",
        account_id: "bank",
        counter_account_id: "divvy",
      }),
    ],
  });
  assert.equal(m.baselineEnding.at(-1) - m.ending.at(-1), 4000000);
  assert.equal(m.ending.at(-1), 13000000);
  assert.equal(m.liquidity.find((a) => a.id === "divvy").ending.at(-1), 0);
  assert.equal(m.liquidity.find((a) => a.id === "bank").ending.at(-1), 8000000);
});
test("monthly override replaces trends across day/week/month views and reset restores baseline", () => {
  const options = {
    transactions: [txn("a", 120, { qbo_account_id: "rent" })],
    overrides: [override({ amount: 500 })],
  };
  const variants = ["day", "week", "month"].map((unit) =>
    build({ ...options, unit }),
  );
  for (const m of variants) {
    assert.equal(m.ending.at(-1), variants[0].ending.at(-1));
    assert.equal(m.low, variants[0].low);
    const row = m.rows.find((r) => r.label === "Rent");
    assert.equal(sum(row.manual), -50000);
    assert.ok(row.overrides.some((ids) => ids.includes("override")));
  }
  const reset = build({
    ...options,
    overrides: [override({ is_active: false })],
  });
  assert.equal(
    reset.ending.at(-1),
    build({ transactions: options.transactions }).ending.at(-1),
  );
});
test("zero override suppresses only the selected direction and stays editable", () => {
  const m = build({
    transactions: [
      txn("out", 120, { qbo_account_id: "rent" }),
      txn("in", -120, { qbo_account_id: "rent" }),
    ],
    overrides: [override({ amount: 0 })],
    unit: "month",
  });
  const i = m.cols.findIndex((c) => c.start === "2026-10-01");
  assert.equal(m.outflow[i], 0);
  assert.ok(m.inflow[i] > 0);
  assert.ok(
    m.rows.find((r) => r.direction === "out").overrides[i].includes("override"),
  );
});
test("money market transfers change both account balances while total cash stays flat", () => {
  const m = build({
    trend: false,
    accounts: [{ ...account, current_balance: 200000 }, moneyMarket],
    plans: [
      plan({
        category: "flow|Transfers",
        amount: -25000,
        kind: "one_time",
        start_date: "2026-10-20",
        account_id: "bank",
        counter_account_id: "market",
      }),
    ],
  });
  assert.equal(m.ending.at(-1), 25000000);
  assert.equal(
    m.liquidity.find((a) => a.id === "bank").ending.at(-1),
    17500000,
  );
  assert.equal(
    m.liquidity.find((a) => a.id === "market").ending.at(-1),
    7500000,
  );
  assert.equal(sum(m.net), 0);
});
test("overriding a transfer removes both old legs before adding the replacement", () => {
  const m = build({
    trend: false,
    accounts: [{ ...account, current_balance: 200000 }, moneyMarket],
    plans: [
      plan({
        category: "flow|Transfers",
        amount: -25000,
        kind: "one_time",
        start_date: "2026-10-20",
        account_id: "bank",
        counter_account_id: "market",
      }),
    ],
    overrides: [
      override({
        scope_group: "cashflow",
        category_key: "Transfers",
        category_label: "Transfers",
        flow_key: "Transfers",
        amount: 40000,
        account_id: "bank",
        counter_account_id: "market",
      }),
    ],
  });
  assert.equal(m.ending.at(-1), 25000000);
  assert.equal(
    m.liquidity.find((a) => a.id === "market").ending.at(-1),
    9000000,
  );
});
test("cashflow group override has final precedence over leaf overrides and cannot double-count", () => {
  const m = build({
    transactions: [txn("a", 120, { qbo_account_id: "rent" })],
    overrides: [
      override({ id: "leaf", amount: 500 }),
      override({
        id: "group",
        scope_group: "cashflow",
        category_key: "Operating",
        category_label: "Operating",
        amount: 700,
      }),
    ],
    unit: "month",
  });
  const i = m.cols.findIndex((c) => c.start === "2026-10-01");
  assert.equal(m.outflow[i], -70000);
});
test("unassigned adjustments reconcile to cash while assigned plans appear in their account view", () => {
  const options = {
    trend: false,
    plans: [
      plan({ kind: "one_time", amount: -100, start_date: "2026-10-20" }),
      plan({
        id: "assigned",
        kind: "one_time",
        amount: -200,
        start_date: "2026-10-20",
        account_id: "bank",
      }),
    ],
  };
  const m = build(options);
  assert.equal(m.ending.at(-1), 70000);
  assert.equal(m.liquidity[0].ending.at(-1), 80000);
  assert.equal(m.unallocatedEnding.at(-1), -10000);
  assert.equal(build({ ...options, selected: "bank" }).ending.at(-1), 80000);
  for (let i = 0; i < m.cols.length; i++)
    if (m.cols[i].kind === "forecast")
      assert.equal(
        m.liquidity
          .filter((a) => a.type === "depository")
          .reduce((n, a) => n + a.ending[i], 0) + m.unallocatedEnding[i],
        m.ending[i],
      );
});
test("a disconnected assigned account is flagged instead of silently moving its plan to another bank", () => {
  const m = build({ plans: [plan({ account_id: "gone" })] });
  assert.ok(m.invalidAssignments.includes("p"));
  assert.equal(m.ending.at(-1), 100000);
});
test("charts handle unknown balances, negative cash and zero movement without invalid SVG numbers", () => {
  for (const options of [
    {},
    { accounts: [{ ...account, current_balance: null }] },
    { accounts: [{ ...account, current_balance: -100 }] },
  ]) {
    const m = build({ ...options, unit: "month", trend: false });
    const html = window.SiloCashflowCharts.render(m, "USD");
    assert.ok(!/NaN|Infinity/.test(html));
    assert.match(html, /Cash (runway|outlook)/);
  }
});
test("an open override prevents refresh from replacing unsaved edits", async () => {
  const h = harness();
  h.el("overrideDialog").open = true;
  await h.api.load();
  assert.equal(h.calls.length, 0);
});
test("a failed zero override save retains the dialog and the amount; retry uses the same company scope", async () => {
  const h = harness({ failSave: true });
  await h.api.load();
  h.api.editOverride();
  h.el("overrideDialog").open = true;
  for (const [id, value] of Object.entries({
    overrideStart: "2026-10-01",
    overrideEnd: "2026-10-31",
    overrideDate: "2026-10-20",
    overrideAmount: "0",
    overrideGroup: "coa",
    overrideCategory: "rent",
    overrideDirection: "out",
  }))
    h.el(id).value = value;
  h.el("overrideCategory").selectedOptions = [
    { textContent: "Rent", dataset: { flow: "Operating" } },
  ];
  await h.api.saveOverride();
  assert.equal(h.el("overrideDialog").open, true);
  assert.equal(h.el("overrideAmount").value, "0");
  assert.match(h.el("overrideError").textContent, /Could not save/);
  const write = h.calls.find((c) => c.write);
  assert.deepEqual(write.filters, [
    ["company_entity_id", "co"],
    ["id", "override"],
    ["updated_at", "old"],
  ]);
});
test("liquidity reconstructs history from the snapshot and reconciles every displayed total", () => {
  const m = build({
    unit: "day",
    trend: false,
    accounts: [account, moneyMarket],
    transactions: [txn("a", 50, { txn_date: "2026-09-12" })],
  });
  const before = m.cols.findIndex((c) => c.start === "2026-09-11"),
    after = m.cols.findIndex((c) => c.start === "2026-09-12");
  assert.equal(m.liquidityTotal[before], 5105000);
  assert.equal(m.liquidityTotal[after], 5100000);
  for (let i = 0; i < m.cols.length; i++)
    assert.equal(
      m.liquidity
        .filter((a) => a.type === "depository")
        .reduce((n, a) => n + a.ending[i], 0) + (m.unallocatedEnding[i] || 0),
      m.liquidityTotal[i],
    );
});

const recurringBills = (
  dates,
  amounts = dates.map(() => 80000),
  merchant = "Divvy payment",
) =>
  dates.map((d, i) =>
    txn("bill-" + i, amounts[i], {
      txn_date: d,
      clean_merchant: merchant,
      qbo_account_id: "rent",
    }),
  );
test("monthly payment timing concentrates the median bill on the observed day instead of spreading it daily", () => {
  const m = build({
    today: "2026-09-30",
    unit: "day",
    transactions: recurringBills(
      ["2026-07-25", "2026-08-25", "2026-09-25"],
      [75000, 80000, 85000],
    ),
  });
  assert.equal(m.patterns.length, 1);
  assert.equal(m.patterns[0].cadence, "monthly");
  assert.equal(m.patterns[0].nextDate, "2026-10-25");
  assert.equal(
    m.outflow[m.cols.findIndex((c) => c.start === "2026-10-25")],
    -8000000,
  );
  assert.equal(m.outflow[m.cols.findIndex((c) => c.start === "2026-10-24")], 0);
});
test("different merchants in one COA retain separate payment dates and irregular activity retains averages", () => {
  const transactions = [
    ...recurringBills(["2026-07-25", "2026-08-25", "2026-09-25"]),
    ...recurringBills(
      ["2026-07-15", "2026-08-15", "2026-09-15"],
      [100, 100, 100],
      "Insurance",
    ).map((t) => ({
      ...t,
      id: "ins-" + t.id,
      external_transaction_id: "ins-" + t.id,
    })),
    txn("oneoff", 200, {
      txn_date: "2026-09-29",
      clean_merchant: "Office supply",
    }),
  ];
  const m = build({ today: "2026-09-30", unit: "day", transactions });
  assert.equal(m.patterns.length, 2);
  assert.ok(m.outflow[m.cols.findIndex((c) => c.start === "2026-10-24")] < 0);
  assert.ok(
    m.outflow[m.cols.findIndex((c) => c.start === "2026-10-25")] < -8000000,
  );
});
test("weekly and fortnightly schedules need four observations; sparse, stale and irregular streams fall back", () => {
  const obs = (dates) => dates.map((date) => ({ date, movement: -10000 }));
  assert.equal(
    M.detectTiming(
      obs(["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]),
      "2026-09-30",
    ).cadence,
    "weekly",
  );
  assert.equal(
    M.detectTiming(
      obs(["2026-08-11", "2026-08-25", "2026-09-08", "2026-09-22"]),
      "2026-09-30",
    ).cadence,
    "biweekly",
  );
  assert.equal(
    M.detectTiming(
      obs(["2026-09-14", "2026-09-21", "2026-09-28"]),
      "2026-09-30",
    ),
    null,
  );
  assert.equal(
    M.detectTiming(
      obs(["2026-07-07", "2026-07-14", "2026-07-21", "2026-07-28"]),
      "2026-09-30",
    ),
    null,
  );
  assert.equal(
    M.detectTiming(
      obs(["2026-07-05", "2026-08-18", "2026-09-25"]),
      "2026-09-30",
    ),
    null,
  );
});
test("month-end timing survives February and a payment already observed this month is not forecast again", () => {
  const p = M.detectTiming(
    ["2026-01-31", "2026-02-28", "2026-03-31"].map((date) => ({
      date,
      movement: -10000,
    })),
    "2026-04-01",
  );
  assert.deepEqual(Array.from(M.timedDates(p, "2026-04-02", "2026-06-30")), [
    "2026-04-30",
    "2026-05-31",
    "2026-06-30",
  ]);
  const m = build({
    today: "2026-09-24",
    transactions: recurringBills(["2026-07-25", "2026-08-25", "2026-09-23"]),
  });
  assert.equal(m.patterns[0].nextDate, "2026-10-25");
});
test("saved recurring plans and overrides still replace detected bank timing; aggregates retain identical totals", () => {
  const options = {
    today: "2026-09-30",
    transactions: recurringBills(["2026-07-25", "2026-08-25", "2026-09-25"]),
    plans: [plan({ amount: -90000, start_date: "2026-10-20" })],
    overrides: [override({ amount: 120000 })],
  };
  const results = ["day", "week", "month"].map((unit) =>
    build({ ...options, unit }),
  );
  for (const m of results) {
    assert.equal(m.ending.at(-1), results[0].ending.at(-1));
    assert.equal(m.low, results[0].low);
    assert.equal(sum(m.rows.flatMap((r) => r.trend)), 0);
  }
  const average = build({
    ...options,
    plans: [],
    overrides: [],
    timing: false,
  });
  assert.equal(average.patterns.length, 0);
});
const revenue = (extra = {}) => ({
  id: "rev",
  projection_date: "2026-10-10",
  projected_sales: 10000,
  location_id: "shop",
  scenario: "active",
  ...extra,
});
test("seasonal revenue projections add independent future cash without replacing bank trend or changing current cash", () => {
  const options = {
    today: "2026-09-30",
    transactions: [txn("receipt", -120, { txn_date: "2026-09-01" })],
  };
  const baseline = build(options),
    m = build({
      ...options,
      projectionEnabled: true,
      projections: [revenue()],
      collectionPercent: 90,
      collectionLag: 2,
      unit: "day",
    });
  assert.equal(m.currentCash, baseline.currentCash);
  assert.equal(m.ending.at(-1) - baseline.ending.at(-1), 900000);
  assert.equal(
    sum(m.rows.flatMap((r) => r.trend)),
    sum(baseline.rows.flatMap((r) => r.trend)),
  );
  const row = m.rows.find((r) => r.label === "Revenue projections");
  assert.equal(
    row.projection[m.cols.findIndex((c) => c.start === "2026-10-12")],
    900000,
  );
  const planningOnly = build({
    ...options,
    trend: false,
    projectionEnabled: true,
    projections: [revenue()],
  });
  assert.equal(planningOnly.ending.at(-1), 1100000);
});
test("projections ignore past/draft/duplicate rows, respect currency/account views and collection horizon", () => {
  const m = build({
    projectionEnabled: true,
    projections: [
      revenue(),
      revenue(),
      revenue({ id: "past", projection_date: "2026-09-01" }),
      revenue({ id: "draft", scenario: "draft" }),
      revenue({ id: "late", projection_date: "2026-12-13" }),
    ],
    collectionLag: 1,
  });
  assert.equal(m.projectionInfo.count, 1);
  assert.equal(m.projectionInfo.total, 1000000);
  assert.equal(
    build({
      projectionEnabled: true,
      selected: "bank",
      projections: [revenue()],
    }).projectionInfo.total,
    0,
  );
  assert.equal(
    build({
      projectionEnabled: true,
      currency: "EUR",
      accounts: [{ ...account, iso_currency_code: "EUR" }],
      projections: [revenue()],
    }).projectionInfo.total,
    0,
  );
});
test("what-if hits are additive after saved overrides and clear back to the saved forecast", () => {
  const options = { trend: false, overrides: [override({ amount: 500 })] },
    saved = build(options);
  const m = build({
    ...options,
    whatIf: [
      {
        id: "scenario",
        currency: "USD",
        date: "2026-10-20",
        amount: -250,
        label: "Inventory",
      },
    ],
  });
  assert.equal(m.currentCash, saved.currentCash);
  assert.equal(m.ending.at(-1), saved.ending.at(-1) - 25000);
  assert.equal(m.savedDaily.at(-1).balance, saved.ending.at(-1));
  assert.equal(m.whatIfTotal, -25000);
  assert.equal(
    m.liquidity[0].ending.at(-1) + m.unallocatedEnding.at(-1),
    m.ending.at(-1),
  );
  assert.equal(
    build({ ...options, whatIf: [] }).ending.at(-1),
    saved.ending.at(-1),
  );
});
test("quick what-if form updates the forecast without writing a database record", async () => {
  const h = harness();
  await h.api.load();
  for (const [id, value] of Object.entries({
    whatIfLabel: "Extra stock",
    whatIfAmount: "500",
    whatIfDirection: "out",
    whatIfDate: "2026-10-20",
  }))
    h.el(id).value = value;
  h.api.addWhatIf();
  assert.match(h.el("whatIfItems").innerHTML, /Extra stock/);
  assert.match(h.el("flowTotals").innerHTML, /-\$500\.00/);
  assert.equal(h.calls.filter((c) => c.write).length, 0);
});
test("unavailable projections do not block bank-only forecasts and an enabled failed layer cannot look complete", async () => {
  const h = harness({ failTable: "revenue_projections" });
  await h.api.load();
  assert.match(h.el("coverage").textContent, /501 posted/);
  assert.match(h.el("projectionStatus").textContent, /unavailable/);
  h.api.projection(true);
  await h.api.load();
  assert.equal(h.el("matrix").innerHTML, "");
  assert.equal(h.el("flowTotals").innerHTML, "");
  assert.match(h.el("projectionStatus").textContent, /Uncheck/);
  h.api.projection(false);
  await h.api.load();
  assert.match(h.el("coverage").textContent, /501 posted/);
});
