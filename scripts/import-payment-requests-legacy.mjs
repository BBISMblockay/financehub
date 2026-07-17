// scripts/import-payment-requests-legacy.mjs
//
// Import legacy Jotform / WPV Portal payment requests into SILO.
//
// Required env:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Usage:
//   node scripts/import-payment-requests-legacy.mjs --file /path/to/export.tsv --dry-run
//   node scripts/import-payment-requests-legacy.mjs --file data/imports/ap-unpaid.csv --unpaid-only --dry-run
//
// Accepts BOTH file formats:
//   - the raw Jotform-sheet header layout (the original pilot format), and
//   - the AP Workbench's own Export CSV (accountspayable.html → Export) —
//     detected automatically and normalized ("Email" → "Your Email" etc.),
//     so you can curate the exact import set on the AP page and upload it.
// --unpaid-only keeps only rows whose Completed column is NOT paid/submitted
// (i.e. the New + Hold queues) — the open AP backlog.
//
// Default file (when --file omitted): data/legacy-payment-requests-pilot.csv

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const LEGACY_SOURCE = "jotform_wpv_export";

// Rows must carry the company explicitly: the stamp_company_entity_id
// trigger resolves active_company_id() from auth.uid(), which is null for
// the service role — without this the imported rows would have a NULL
// company_entity_id and be invisible to every RLS-scoped user. (The 13
// pilot rows only have one because the 2026-06-16 multi-tenant backfill
// ran after that import.)
const DEFAULT_COMPANY_ENTITY_ID = "3bd934c9-4cdd-429b-9076-f8f6b45d4eb7"; // Baseballism

const REQUEST_TYPE_MAP = {
  "employee reimbursement": "employee_reimbursement",
  "invoice / vendor payment": "invoice_vendor_payment",
  "customer refund": "customer_refund",
  "inventory - balance": "inventory_balance",
  "inventory - deposit": "inventory_deposit",
};

const PAYMENT_TYPE_MAP = {
  wire: "wire",
  "credit card": "credit_card",
  check: "check",
  other: "other",
  "wire - credit card": "other",
};

function parseArgs(argv) {
  const args = { file: null, dryRun: false, unpaidOnly: false, company: null };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--unpaid-only") args.unpaidOnly = true;
    else if (token === "--company") {
      args.company = argv[i + 1];
      i += 1;
    } else if (token === "--file") {
      args.file = argv[i + 1];
      i += 1;
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    }
  }
  return args;
}

function usage() {
  console.log(`Usage:
  node scripts/import-payment-requests-legacy.mjs [--file <path>] [--unpaid-only] [--company <uuid>] [--dry-run]

Env:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
`);
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function parseMoney(value) {
  const raw = String(value ?? "").replace(/[$,]/g, "").trim();
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

// The AP Workbench export writes date cells as the sheet's raw gviz value,
// which serializes as "Date(2026,6,20)" — note the 0-based month.
function parseGvizDateLiteral(text) {
  const m = String(text || "").match(/^Date\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2})(?:,\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2}))?\)$/i);
  if (!m) return null;
  return new Date(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

function parseSubmissionDate(value) {
  const text = cleanText(value);
  if (!text) return null;
  const gviz = parseGvizDateLiteral(text);
  if (gviz) return gviz.toISOString();
  // ISO-ish "2026-05-27 09:15:22" needs the T; US-format sheet dates
  // ("7/1/2026 10:00:00") parse as-is and break with it.
  let d = new Date(text.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseDueDate(value) {
  const text = cleanText(value);
  if (!text) return null;

  const gviz = parseGvizDateLiteral(text);
  if (gviz) {
    const mm = String(gviz.getMonth() + 1).padStart(2, "0");
    const dd = String(gviz.getDate()).padStart(2, "0");
    return `${gviz.getFullYear()}-${mm}-${dd}`;
  }

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  const usMatch = text.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (usMatch) {
    const mm = usMatch[1].padStart(2, "0");
    const dd = usMatch[2].padStart(2, "0");
    return `${usMatch[3]}-${mm}-${dd}`;
  }

  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseCompletedDate(value) {
  return parseDueDate(value);
}

function mapRequestType(value) {
  const key = String(value || "").trim().toLowerCase();
  if (!key) return "invoice_vendor_payment";
  const mapped = REQUEST_TYPE_MAP[key];
  if (!mapped) throw new Error(`Unknown request type: ${value}`);
  return mapped;
}

function mapPaymentType(value) {
  const key = String(value || "").trim().toLowerCase();
  if (!key) return null;
  return PAYMENT_TYPE_MAP[key] || "other";
}

// Mirrors accountspayable.html's mapCompletionToStatus: paid/submitted are
// closed; "hold" is an open item waiting on something → needs_info in SILO
// (previously imported as plain "new", losing the hold signal); everything
// else is a new open request.
function mapCompleted(value) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "paid" || key === "yes" || key === "true" || key === "completed" || key.includes("paid") || key.includes("submitted")) {
    return { completed: true, workflow_status: "paid" };
  }
  if (key.includes("hold")) {
    return { completed: false, workflow_status: "needs_info" };
  }
  return { completed: false, workflow_status: "new" };
}

export function isPaidRow(row) {
  return mapCompleted(row.Completed).completed;
}

function parseFileUrls(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
}

function fileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(parsed.pathname.split("/").pop() || "attachment");
    return last || "attachment";
  } catch {
    return "attachment";
  }
}

function externalFilePath(url) {
  return String(url || "").trim();
}

function buildFileRows(requestId, fileUrls) {
  return fileUrls.map((url, index) => ({
    payment_request_id: requestId,
    file_name: fileNameFromUrl(url),
    file_path: externalFilePath(url),
    file_url: url,
    file_size: null,
    mime_type: null,
    sort_order: index + 1,
    created_by: null,
  }));
}

function extractLegacyExternalId(pageUrl, row) {
  const text = String(pageUrl || "").trim();
  const editMatch = text.match(/jotform\.com\/(?:edit|grid)\/(\d+)/i);
  if (editMatch) return editMatch[1];

  const hashInput = [
    cleanText(row["Submission Date"]) || "",
    normalizeEmail(row["Your Email"]) || "",
    String(parseMoney(row["Amount Due"]) ?? ""),
    normalizeName(row["Vendor"] || row["*Vendor Name if not listed above *"]) || "",
    cleanText(row["Invoice #"]) || "",
  ].join("|");

  return crypto.createHash("sha256").update(hashInput).digest("hex").slice(0, 24);
}

function readExportRows(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`File not found: ${absolute}`);
  }

  const raw = fs.readFileSync(absolute, "utf8");
  const parsed = Papa.parse(raw, {
    header: true,
    skipEmptyLines: true,
    delimiter: raw.includes("\t") ? "\t" : ",",
  });

  if (parsed.errors?.length) {
    const first = parsed.errors[0];
    throw new Error(`Parse error at row ${first.row}: ${first.message}`);
  }

  return parsed.data;
}

/* ------------------------------------------------------------------
   AP Workbench export support.
   The AP Manager's "Export" button writes a CSV with its own header set
   ("Email" instead of "Your Email", "Notes" instead of "Note & Comments",
   files pipe-joined instead of newline-separated, "Edit Link" instead of
   "Get Page URL"). Detect that shape and normalize each row to the raw
   Jotform-sheet keys buildRequestPayload expects, so the file you curate
   on the AP page imports without silent field mis-mapping.
------------------------------------------------------------------- */
const WORKBENCH_HEADER_MAP = {
  "Category Type": "Type",
  "Payment Method": "Type 2",
  "Flex ID": "Flex ID#",
  "Internal PO": "Internal PO #",
  "Email": "Your Email",
  "Notes": "Note & Comments",
  "Edit Link": "Get Page URL", // both carry the Jotform submission id for dedupe
};

export function isWorkbenchExportRow(row) {
  return ("Category Type" in row || "Payment Method" in row) && !("Type 2" in row);
}

export function normalizeWorkbenchRow(row) {
  const out = { ...row };
  for (const [from, to] of Object.entries(WORKBENCH_HEADER_MAP)) {
    if (from in out && !(to in out)) out[to] = out[from];
  }
  // Export joins file URLs with " | "; the raw sheet separates with newlines.
  if (out.Files != null && out["File Upload"] == null) {
    out["File Upload"] = String(out.Files).split(/\s*\|\s*/).join("\n");
  }
  return out;
}

export function buildRequestPayload(row, { companyEntityId = DEFAULT_COMPANY_ENTITY_ID } = {}) {
  const vendorListed = cleanText(row.Vendor);
  const vendorManual = cleanText(row["*Vendor Name if not listed above *"]);
  const displayVendor = vendorManual || vendorListed || "Unknown vendor";
  const effectiveVendorNorm = normalizeName(vendorManual || vendorListed);
  const completedState = mapCompleted(row.Completed);
  const fileUrls = parseFileUrls(row["File Upload"]);
  const primaryUrl = fileUrls[0] || null;
  const legacyUrl = cleanText(row["Get Page URL"]);
  const legacyExternalId = extractLegacyExternalId(legacyUrl, row);
  const submittedAt = parseSubmissionDate(row["Submission Date"]);

  return {
    request: {
      vendor_name: vendorListed,
      vendor_name_norm: vendorListed ? normalizeName(vendorListed) : effectiveVendorNorm,
      vendor_name_manual: vendorManual,
      vendor_name_manual_norm: vendorManual ? normalizeName(vendorManual) : effectiveVendorNorm,
      request_type: mapRequestType(row.Type),
      invoice_number: cleanText(row["Invoice #"]),
      flex_id: cleanText(row["Flex ID#"]),
      internal_po_number: cleanText(row["Internal PO #"]),
      amount_due: parseMoney(row["Amount Due"]),
      due_date: parseDueDate(row["Due Date"]),
      requester_email: cleanText(row["Your Email"]),
      requester_email_norm: normalizeEmail(row["Your Email"]) || null,
      location_name: cleanText(row.Location),
      notes_comments: cleanText(row["Note & Comments"]),
      file_name: primaryUrl ? fileNameFromUrl(primaryUrl) : null,
      file_path: primaryUrl ? externalFilePath(primaryUrl) : null,
      file_url: primaryUrl,
      payment_type: mapPaymentType(row["Type 2"]),
      payment_detail: cleanText(row["Payment Detail"]),
      workflow_status: completedState.workflow_status,
      completed: completedState.completed,
      date_completed: completedState.completed ? parseCompletedDate(row["Date Completed"]) : null,
      priority: "normal",
      company_entity_id: companyEntityId,
      legacy_source: LEGACY_SOURCE,
      legacy_url: legacyUrl,
      legacy_external_id: legacyExternalId,
      imported_at: new Date().toISOString(),
      ...(submittedAt ? { created_at: submittedAt, updated_at: submittedAt } : {}),
    },
    fileUrls,
    legacyExternalId,
    displayVendor,
  };
}

async function fetchExistingLegacyRecords(supabase) {
  const records = new Map();
  let from = 0;
  const size = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("payment_requests")
      .select("id, legacy_external_id")
      .eq("legacy_source", LEGACY_SOURCE)
      .range(from, from + size - 1);

    if (error) throw error;
    for (const row of data || []) {
      if (row.legacy_external_id) records.set(row.legacy_external_id, row);
    }
    if (!data || data.length < size) break;
    from += size;
  }

  return records;
}

async function requestHasFiles(supabase, requestId) {
  const { count, error } = await supabase
    .from("payment_request_files")
    .select("id", { count: "exact", head: true })
    .eq("payment_request_id", requestId);

  if (error) throw error;
  return (count || 0) > 0;
}

async function insertRequestFiles(supabase, requestId, fileUrls) {
  if (!fileUrls.length) return;

  const { error: fileError } = await supabase
    .from("payment_request_files")
    .insert(buildFileRows(requestId, fileUrls));

  if (fileError) throw fileError;
}

async function importRow(supabase, built, { dryRun }) {
  const requestId = crypto.randomUUID();
  const payload = { id: requestId, ...built.request };

  if (dryRun) {
    return { action: "would_insert", requestId, legacyExternalId: built.legacyExternalId };
  }

  const { error: insertError } = await supabase.from("payment_requests").insert(payload);
  if (insertError) throw insertError;

  await insertRequestFiles(supabase, requestId, built.fileUrls);

  const { error: activityError } = await supabase.from("payment_request_activity").insert({
    payment_request_id: requestId,
    activity_type: "note_added",
    message: "Imported from legacy Jotform / WPV Portal export",
    created_by: null,
  });
  if (activityError) throw activityError;

  return { action: "inserted", requestId, legacyExternalId: built.legacyExternalId };
}

async function repairExistingRow(supabase, existingRow, built) {
  const hasFiles = await requestHasFiles(supabase, existingRow.id);
  if (hasFiles || !built.fileUrls.length) {
    return { action: "skipped", requestId: existingRow.id, legacyExternalId: built.legacyExternalId };
  }

  await insertRequestFiles(supabase, existingRow.id, built.fileUrls);
  return { action: "repaired", requestId: existingRow.id, legacyExternalId: built.legacyExternalId };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }

  const dryRun = args.dryRun;
  const companyEntityId = args.company || DEFAULT_COMPANY_ENTITY_ID;

  const filePath = args.file || path.join(ROOT, "data/legacy-payment-requests-pilot.csv");
  let rows = readExportRows(filePath);
  console.log(`Read ${rows.length} row(s) from ${path.resolve(filePath)}`);

  if (rows.length && isWorkbenchExportRow(rows[0])) {
    rows = rows.map(normalizeWorkbenchRow);
    console.log("Detected AP Workbench export format — headers normalized");
  }

  if (args.unpaidOnly) {
    const before = rows.length;
    rows = rows.filter((row) => !isPaidRow(row));
    console.log(`Unpaid-only: kept ${rows.length} of ${before} rows (dropped paid/submitted)`);
  }

  console.log(`Company: ${companyEntityId}`);
  console.log(dryRun ? "DRY RUN — no database writes" : "LIVE IMPORT");

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let supabase = null;
  let existingRecords = new Map();

  if (!dryRun) {
    if (!supabaseUrl || !serviceKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    existingRecords = await fetchExistingLegacyRecords(supabase);
  } else if (supabaseUrl && serviceKey) {
    supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    existingRecords = await fetchExistingLegacyRecords(supabase);
  }

  const summary = { inserted: 0, skipped: 0, repaired: 0, failed: 0, wouldInsert: 0 };

  for (const [index, row] of rows.entries()) {
    const label = `Row ${index + 1}`;
    try {
      const built = buildRequestPayload(row, { companyEntityId });
      if (!built.request.amount_due && built.request.amount_due !== 0) {
        throw new Error("missing or invalid Amount Due");
      }
      if (!built.request.requester_email) {
        throw new Error("missing requester email");
      }

      const existingRow = existingRecords.get(built.legacyExternalId);
      if (existingRow) {
        if (dryRun) {
          summary.skipped += 1;
          console.log(`${label}: skip (already imported, legacy_external_id=${built.legacyExternalId}) — ${built.displayVendor}`);
          continue;
        }

        const result = await repairExistingRow(supabase, existingRow, built);
        if (result.action === "repaired") {
          summary.repaired += 1;
          console.log(`${label}: repaired files for ${result.requestId} — ${built.displayVendor}`);
        } else {
          summary.skipped += 1;
          console.log(`${label}: skip (already imported, legacy_external_id=${built.legacyExternalId}) — ${built.displayVendor}`);
        }
        continue;
      }

      const result = await importRow(supabase, built, { dryRun });
      if (result.action === "would_insert") {
        summary.wouldInsert += 1;
        console.log(`${label}: would insert — ${built.displayVendor} · $${built.request.amount_due} · ${built.legacyExternalId}`);
      } else {
        summary.inserted += 1;
        existingRecords.set(built.legacyExternalId, { id: result.requestId, legacy_external_id: built.legacyExternalId });
        console.log(`${label}: inserted ${result.requestId} — ${built.displayVendor}`);
      }
    } catch (err) {
      summary.failed += 1;
      console.error(`${label}: FAILED — ${err.message || err}`);
    }
  }

  console.log("\nSummary:", summary);
  if (summary.failed > 0) process.exitCode = 1;
}

// Only auto-run when executed directly — lets tests import gvizToRows etc.
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
