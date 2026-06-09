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
//   node scripts/import-payment-requests-legacy.mjs --file data/legacy-payment-requests-pilot.csv
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
  const args = { file: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--file") {
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
  node scripts/import-payment-requests-legacy.mjs [--file <path>] [--dry-run]

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

function parseSubmissionDate(value) {
  const text = cleanText(value);
  if (!text) return null;
  const d = new Date(text.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseDueDate(value) {
  const text = cleanText(value);
  if (!text) return null;

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

function mapCompleted(value) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "paid" || key === "yes" || key === "true" || key === "completed") {
    return { completed: true, workflow_status: "paid" };
  }
  return { completed: false, workflow_status: "new" };
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

function buildRequestPayload(row) {
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

  const filePath = args.file || path.join(ROOT, "data/legacy-payment-requests-pilot.csv");
  const dryRun = args.dryRun;

  const rows = readExportRows(filePath);
  console.log(`Read ${rows.length} row(s) from ${path.resolve(filePath)}`);
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
      const built = buildRequestPayload(row);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
