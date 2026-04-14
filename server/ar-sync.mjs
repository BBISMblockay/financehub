// file: server/ar-sync.mjs

import crypto from "crypto";
import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

const SALES_CSV_SOURCES = [
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vStgtzXpQpW_9oWh4QC2NOoO7F9L0fJLM7EDP7To0DyDp0TWaFk4V9YUxJVs9NRRv_7-bof9I-Gcc2J/pub?gid=0&single=true&output=csv",
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vStgtzXpQpW_9oWh4QC2NOoO7F9L0fJLM7EDP7To0DyDp0TWaFk4V9YUxJVs9NRRv_7-bof9I-Gcc2J/pub?gid=801564681&single=true&output=csv"
];

const TERMS_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vStgtzXpQpW_9oWh4QC2NOoO7F9L0fJLM7EDP7To0DyDp0TWaFk4V9YUxJVs9NRRv_7-bof9I-Gcc2J/pub?gid=814012167&single=true&output=csv";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function cleanNumber(value) {
  if (value == null || value === "") return 0;
  const n = Number(String(value).replace(/[$,()\s]/g, "").replace(/−/g, "-"));
  return Number.isFinite(n) ? n : 0;
}

function cleanInt(value) {
  if (value == null || value === "") return 0;
  const n = Number(String(value).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parseDateFlex(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

function toDateString(date) {
  if (!date) return null;
  return date.toISOString().slice(0, 10);
}

function stripTime(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date, days) {
  if (!date) return null;
  const d = stripTime(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function diffDays(a, b) {
  return Math.floor((stripTime(a) - stripTime(b)) / 86400000);
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeCustomerName(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStatus(v) {
  return String(v || "").trim().toLowerCase();
}

function detectDateKey(row) {
  const keys = Object.keys(row || {});
  const preferred = ["DAY Order Date", "Order Date", "Created at", "Date"];
  for (const key of preferred) {
    if (keys.includes(key)) return key;
  }
  return keys.find((k) => /date/i.test(k)) || null;
}

function detectTermsColumns(row) {
  const keys = Object.keys(row || {});
  const findKey = (patterns) => {
    for (const k of keys) {
      const lk = k.toLowerCase().trim();
      if (patterns.some((p) => lk === p || lk.includes(p))) return k;
    }
    return null;
  };

  return {
    customer: findKey(["customer", "customer name"]),
    email: findKey(["email", "customer email"]),
    termDays: findKey(["term days", "terms days", "term", "net days"])
  };
}

function agingBucket(daysPastDue, openAmount) {
  if (openAmount <= 0) return "paid";
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "1-30";
  if (daysPastDue <= 60) return "31-60";
  if (daysPastDue <= 90) return "61-90";
  return "90+";
}

async function fetchCsvRows(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed CSV fetch: ${url} (${res.status})`);
  const text = await res.text();

  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true
  });

  if (parsed.errors?.length) {
    console.warn("CSV parse warnings:", parsed.errors.slice(0, 5));
  }

  return parsed.data || [];
}

function normalizeTermsRows(rows) {
  if (!rows.length) return [];

  const cols = detectTermsColumns(rows[0]);

  return rows
    .map((row) => {
      const customer = String(row[cols.customer] || "").trim();
      const email = String(row[cols.email] || "").trim();
      const termDays = cleanInt(row[cols.termDays]);

      return {
        customer,
        email,
        customerNorm: normalizeCustomerName(customer),
        emailNorm: normalizeEmail(email),
        termDays
      };
    })
    .filter((r) => (r.customerNorm || r.emailNorm) && Number.isFinite(r.termDays));
}

function buildTermsIndexes(rows) {
  const byEmail = new Map();
  const byCustomer = new Map();

  for (const row of rows) {
    if (row.emailNorm && !byEmail.has(row.emailNorm)) byEmail.set(row.emailNorm, row);
    if (row.customerNorm && !byCustomer.has(row.customerNorm)) byCustomer.set(row.customerNorm, row);
  }

  return { byEmail, byCustomer };
}

function normalizeSalesRow(row, sourceIndex) {
  const dateKey = detectDateKey(row);
  const orderDate = parseDateFlex(row[dateKey]);

  const gross = cleanNumber(row["Total gross sales"]);
  const discounts = cleanNumber(row["Total discounts"]);
  const refunds = cleanNumber(row["Total refunds"]);
  const shipping = cleanNumber(row["Total shipping"]);
  const taxes = cleanNumber(row["Total taxes"]);
  const sales = cleanNumber(row["Total sales"]);
  const quantity = cleanInt(row["Order Total quantity"]);

  const financialStatus = normalizeStatus(row["Order Financial status"]);
  const fulfillment = normalizeStatus(row["Order Fulfillment status"]);

  const customer =
    String(row["Customer Full name 🔗"] || row["Customer Full name"] || "Unknown Customer").trim() ||
    "Unknown Customer";

  const email = String(row["Customer Email 🔗"] || row["Customer Email"] || "").trim();

  const tags = String(row["Customer tags"] || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const openStatuses = new Set(["pending", "authorized", "partially_paid", "partially paid", "due", "unpaid", "open"]);
  const paidStatuses = new Set(["paid", "partially_refunded", "partially refunded"]);
  const closedStatuses = new Set(["voided", "refunded", "expired"]);

  let settlementClass = "other";
  if (openStatuses.has(financialStatus)) settlementClass = "open";
  else if (paidStatuses.has(financialStatus)) settlementClass = "paid";
  else if (closedStatuses.has(financialStatus)) settlementClass = "closed";

  let openAmount = settlementClass === "open" ? Math.max(0, sales) : 0;
  if (sales <= 0) openAmount = 0;
  if (refunds >= Math.max(gross, sales) && Math.max(gross, sales) > 0) openAmount = 0;

  return {
    sourceIndex,
    sourceName: `google_sheet_${sourceIndex}`,
    orderDate,
    customer,
    email,
    customerNorm: normalizeCustomerName(customer),
    emailNorm: normalizeEmail(email),
    tags,
    orderName: String(row["Order name"] || "").trim(),
    fulfillment,
    financialStatus,
    settlementClass,
    quantity,
    gross,
    discounts,
    refunds,
    shipping,
    taxes,
    sales,
    openAmount,
    paidAmount: settlementClass === "paid" ? Math.max(0, sales) : 0
  };
}

function applyTermsAndAging(rows, termsIndexes, asOfDate = new Date()) {
  for (const row of rows) {
    let match = null;
    let matchedBy = "default";

    if (termsIndexes.byEmail.has(row.emailNorm)) {
      match = termsIndexes.byEmail.get(row.emailNorm);
      matchedBy = "email";
    } else if (termsIndexes.byCustomer.has(row.customerNorm)) {
      match = termsIndexes.byCustomer.get(row.customerNorm);
      matchedBy = "customer";
    }

    row.termDays = match ? cleanInt(match.termDays) : 0;
    row.matchedBy = matchedBy;
    row.agingBasis = "terms";

    row.dueDate = row.orderDate ? addDays(row.orderDate, row.termDays) : null;

    if (!row.orderDate || row.openAmount <= 0) {
      row.daysPastDue = 0;
      row.agingBucket = "paid";
      row.isOpen = false;
    } else {
      const basisDate = row.dueDate || row.orderDate;
      row.daysPastDue = diffDays(asOfDate, basisDate);
      row.agingBucket = agingBucket(row.daysPastDue, row.openAmount);
      row.isOpen = row.openAmount > 0;
    }
  }

  return rows;
}

function buildSourceRowHash(row) {
  const raw = [
    row.sourceName,
    toDateString(row.orderDate),
    row.customerNorm,
    row.emailNorm,
    row.orderName,
    row.sales.toFixed(2),
    row.openAmount.toFixed(2),
    row.financialStatus
  ].join("|");

  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function upsertCustomers(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const key = `${row.customerNorm}__${row.emailNorm || ""}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        customer_name: row.customer,
        customer_name_norm: row.customerNorm,
        email: row.email || null,
        email_norm: row.emailNorm || null,
        term_days: row.termDays || 0
      });
    }
  }

  const payload = Array.from(grouped.values());

  if (!payload.length) return new Map();

  const { error } = await supabase
    .from("ar_customers")
    .upsert(payload, {
      onConflict: "customer_name_norm,email_norm",
      ignoreDuplicates: false
    });

  if (error) throw error;

  const { data, error: fetchError } = await supabase
    .from("ar_customers")
    .select("id, customer_name_norm, email_norm");

  if (fetchError) throw fetchError;

  const map = new Map();
  for (const c of data || []) {
    const key = `${c.customer_name_norm}__${c.email_norm || ""}`;
    map.set(key, c.id);
  }

  return map;
}

async function upsertInvoices(rows, customerIdMap) {
  const payload = rows.map((row) => {
    const customerKey = `${row.customerNorm}__${row.emailNorm || ""}`;
    const customerId = customerIdMap.get(customerKey);

    if (!customerId) {
      throw new Error(`Missing customer_id for ${row.customer} / ${row.email || "no email"}`);
    }

    const sourceRowHash = buildSourceRowHash(row);

    return {
      customer_id: customerId,
      source_name: row.sourceName,
      source_index: row.sourceIndex,
      source_row_hash: sourceRowHash,
      external_order_id: null,
      order_name: row.orderName || "Unknown Order",
      order_date: toDateString(row.orderDate),
      due_date: toDateString(row.dueDate),
      term_days: row.termDays || 0,
      customer_name: row.customer,
      customer_email: row.email || null,
      customer_tags: row.tags || [],
      fulfillment_status: row.fulfillment || null,
      financial_status: row.financialStatus || null,
      settlement_class: row.settlementClass || null,
      quantity: row.quantity || 0,
      gross_amount: row.gross || 0,
      discounts_amount: row.discounts || 0,
      refunds_amount: row.refunds || 0,
      shipping_amount: row.shipping || 0,
      taxes_amount: row.taxes || 0,
      sales_amount: row.sales || 0,
      open_amount: row.openAmount || 0,
      paid_amount: row.paidAmount || 0,
      matched_by: row.matchedBy || "default",
      aging_basis: row.agingBasis || "terms",
      days_past_due: row.daysPastDue || 0,
      aging_bucket: row.agingBucket || "paid",
      is_open: !!row.isOpen,
      last_seen_at: new Date().toISOString()
    };
  });

  const chunkSize = 500;
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);

    const { error } = await supabase
      .from("ar_invoices")
      .upsert(chunk, {
        onConflict: "source_row_hash",
        ignoreDuplicates: false
      });

    if (error) throw error;
  }
}

async function refreshCustomerSummary() {
  const { error } = await supabase.rpc("refresh_ar_customer_summary");
  if (error) throw error;
}

async function saveSyncState(summary) {
  const { error } = await supabase.from("sync_state").upsert(
    {
      key: "ar_google_sheets_sync",
      value: summary,
      updated_at: new Date().toISOString()
    },
    { onConflict: "key" }
  );

  if (error) {
    console.warn("sync_state upsert skipped:", error.message);
  }
}

export async function runArSync() {
  const startedAt = new Date().toISOString();

  const [salesArrays, termsRowsRaw] = await Promise.all([
    Promise.all(SALES_CSV_SOURCES.map((url) => fetchCsvRows(url))),
    fetchCsvRows(TERMS_CSV_URL)
  ]);

  const salesRows = salesArrays.flatMap((rows, idx) =>
    rows.map((row) => normalizeSalesRow(row, idx + 1))
  );

  const termsRows = normalizeTermsRows(termsRowsRaw);
  const termsIndexes = buildTermsIndexes(termsRows);

  const finalRows = applyTermsAndAging(salesRows, termsIndexes, new Date());

  const customerIdMap = await upsertCustomers(finalRows);
  await upsertInvoices(finalRows, customerIdMap);
  await refreshCustomerSummary();

  const summary = {
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    sales_row_count: finalRows.length,
    terms_row_count: termsRows.length,
    customer_count: customerIdMap.size
  };

  await saveSyncState(summary);

  return summary;
}
